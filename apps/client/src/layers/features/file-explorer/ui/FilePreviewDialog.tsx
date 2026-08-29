/**
 * Read — and, where the place behind the source allows it, change — one file
 * that has nowhere else to open (spec `project-rooms` §3.9, §3.10).
 *
 * The session pane opens a file into the canvas, beside the conversation it
 * belongs to. A room's files have no conversation to sit beside, so they are
 * read here instead — a dialog on a desktop, a drawer on a phone, closed with
 * Escape either way.
 *
 * **One dialog, two states, deliberately.** A person opens a file to read it
 * and then decides to change it; making that decision a second navigation is
 * the kind of small tax that stops people fixing the typo they just found. So
 * the pencil turns this window into an editor in place and the same header
 * keeps saying which file it is.
 *
 * **Everything it shows was written by the room's members.** Markdown renders
 * through the same static renderer every other untrusted surface uses, which
 * sanitises the tags and puts every link behind the shared confirmation; text
 * renders as text in a `<pre>`. Nothing on this path takes raw HTML.
 *
 * **The editor is the file's own text, not a rendering of it.** A room's files
 * are a git repo whose whole point is per-line provenance and honest diffs, and
 * a rich editor round-trips markdown through its own document model — so
 * opening `ROOM.md` and saving it could commit a wholesale reformat under a
 * person's name that they never typed and cannot see. What is edited here is
 * exactly the bytes that will land.
 *
 * @module features/file-explorer/ui/FilePreviewDialog
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileWarning, Loader2, Pencil } from 'lucide-react';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import {
  Button,
  MarkdownContent,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import { baseName } from '../model/tree';
import { provenanceLine } from '../lib/provenance';
import type {
  ExplorerCommit,
  ExplorerFile,
  ExplorerSaveOutcome,
  FileExplorerSource,
} from '../model/source';

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

/**
 * Whether this file, as it was answered, is one a person may change here.
 *
 * Three conditions and all of them are about honesty rather than capability:
 * the place has to accept writes at all, the bytes have to be here (a file too
 * large to show is a file too large to save back), and it has to be markdown —
 * which is where §3.10 starts, other text types later.
 *
 * @param source - Where the file came from.
 * @param file - The file as it was read.
 */
function canEdit(source: FileExplorerSource, file: ExplorerFile | undefined): boolean {
  return (
    source.editable &&
    source.save !== undefined &&
    file !== undefined &&
    file.body.kind === 'text' &&
    isMarkdownPath(file.path)
  );
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
 * Show one file from a source that previews in place, and let a person change
 * it where the source allows.
 *
 * @param props - The source, the open path, and how to close.
 */
export function FilePreviewDialog({ source, path, onClose }: FilePreviewDialogProps) {
  const read = source.read;
  const queryClient = useQueryClient();
  const previewKey = ['file-explorer', 'preview', source.scopeKey, path] as const;
  const query = useQuery({
    queryKey: previewKey,
    queryFn: () => read!(path!),
    enabled: path !== null && read !== undefined,
  });

  const file = query.data;

  /** Whether the person is editing, and what they have typed so far. */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  /**
   * The version this draft is measured against — both "have you changed
   * anything" and the optimistic lock a save carries.
   *
   * Kept apart from the query's copy because they diverge exactly when it
   * matters: a save that lands moves this forward while the cached read is
   * still the old one, and taking the other person's version moves it forward
   * without anything of ours being saved.
   */
  const [base, setBase] = useState<{ text: string; commit: string | null }>({
    text: '',
    commit: null,
  });
  const [conflict, setConflict] = useState<{
    commit: string;
    lastCommit: ExplorerCommit | null;
    /**
     * Whether this is a SECOND race lost while the first was being decided.
     *
     * Without it the banner after a failed "save mine over it" is byte-identical
     * to the one already on screen, so the press reads as a dead button rather
     * than as the room having moved again underneath the decision.
     */
    again: boolean;
  } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /** Raised when a close would throw away typing, and answered before it does. */
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  /** The two ends of the mode switch, so the cursor can follow it. */
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const pencilRef = useRef<HTMLButtonElement | null>(null);
  /** Whether edit mode has been entered, so opening the dialog steals no focus. */
  const hasEdited = useRef(false);

  const dirty = editing && draft !== base.text;
  /**
   * Whether the "you haven't saved" prompt is actually up.
   *
   * Derived from the ask AND the draft rather than stored alone: a save landing
   * while the prompt is open, or the text being walked back to where it
   * started, leaves it with nothing to ask — and a stored flag would keep
   * asking it.
   */
  const askingDiscard = confirmingDiscard && dirty;

  /** Put every editing state back, for a file that is no longer the open one. */
  const resetEditing = useCallback(() => {
    setEditing(false);
    setDraft('');
    setBase({ text: '', commit: null });
    setConflict(null);
    setRefusal(null);
    setSaved(false);
    setConfirmingDiscard(false);
  }, []);

  // A different file is a different edit. Without this, opening a second file
  // while the first was being edited would show the first one's draft under the
  // second one's name — and save it there.
  //
  // Adjusted during render rather than in an effect, which is what React asks
  // for when state has to follow a prop: the extra pass happens before anything
  // is committed, so no frame ever shows the wrong file's draft.
  const [openedPath, setOpenedPath] = useState<string | null>(path);
  if (openedPath !== path) {
    setOpenedPath(path);
    if (editing || draft !== '' || conflict !== null || refusal !== null || saved) resetEditing();
  }

  const save = useMutation({
    mutationFn: (input: {
      text: string;
      baseCommit: string | null;
    }): Promise<ExplorerSaveOutcome> =>
      source.save!({ path: path!, baseCommit: input.baseCommit, text: input.text }),
    onSuccess: (outcome, input) => {
      if (outcome.status === 'saved') {
        setBase({ text: input.text, commit: outcome.commit });
        setConflict(null);
        setRefusal(null);
        setSaved(true);
        // The listing this file sits in now has a different provenance line and
        // a different size, and the cached read is a version behind. Both are
        // the room's answer rather than ours to patch, so both are re-asked.
        void queryClient.invalidateQueries({ queryKey: previewKey });
        // Every listing of this source, not only the directory the file is in:
        // the key partitions on show-hidden as well as on directory, so naming
        // one of them would leave the other showing the size and the author the
        // file had a moment ago.
        void queryClient.invalidateQueries({
          queryKey: ['file-explorer', 'tree', source.scopeKey],
        });
        return;
      }
      setSaved(false);
      if (outcome.status === 'conflict') {
        setConflict((previous) => ({
          commit: outcome.commit,
          lastCommit: outcome.lastCommit,
          again: previous !== null,
        }));
        setRefusal(null);
        return;
      }
      setConflict(null);
      setRefusal(outcome.reason);
    },
    onError: () => {
      setSaved(false);
      setConflict(null);
      setRefusal('That didn’t save. Try again in a moment.');
    },
  });

  const editable = canEdit(source, file);

  const enterEdit = () => {
    if (file === undefined || file.body.kind !== 'text') return;
    setDraft(file.body.text);
    setBase({ text: file.body.text, commit: file.commit ?? null });
    setConflict(null);
    setRefusal(null);
    setSaved(false);
    setEditing(true);
  };

  /** Leave edit mode, keeping nothing. */
  const leaveEdit = () => {
    setEditing(false);
    setDraft('');
    setConflict(null);
    setRefusal(null);
    setConfirmingDiscard(false);
  };

  /**
   * Take the other person's version: re-read the file and edit that instead.
   *
   * **Every path out of here that is not a successful text read leaves the
   * choice on screen.** This is the one gesture in the dialog that destroys
   * typing on purpose, so it may only do so when it really has the other
   * version in hand — and there are two ways it can fail to.
   */
  const takeTheirs = async () => {
    const result = await query.refetch();
    // **A failed refetch still RESOLVES, and `data` still holds the last
    // successful read** — which here is the text from before the conflict.
    // Adopting it would throw away what was typed, call the pre-conflict
    // version "theirs", and move the optimistic lock onto a commit the room has
    // already left. Nothing is changed and the choice stays takeable.
    if (result.isError || result.data === undefined) {
      setRefusal('Their version couldn’t be fetched just now, so nothing here changed.');
      return;
    }
    const theirs = result.data;
    // Not text is not a dead end either, and its likeliest cause is the whole
    // point of saying so: the other person DELETED the file, which is a
    // conflict like any other and re-reads as "not in the room's files any
    // more". Returning silently here left the button doing nothing, forever.
    if (theirs.body.kind !== 'text') {
      setRefusal(
        theirs.body.kind === 'not-readable'
          ? `${theirs.body.reason} What you typed is still here — save it over their change, or close this and copy it out first.`
          : 'Their version isn’t something that can be shown here, so nothing here changed.'
      );
      return;
    }
    setDraft(theirs.body.text);
    setBase({ text: theirs.body.text, commit: theirs.commit ?? null });
    setConflict(null);
    setRefusal(null);
  };

  /** Keep what was typed, over the version that landed while it was being typed. */
  const keepMine = () => {
    if (conflict === null) return;
    save.mutate({ text: draft, baseCommit: conflict.commit });
  };

  const requestClose = () => {
    if (dirty) {
      setConfirmingDiscard(true);
      return;
    }
    resetEditing();
    onClose();
  };

  // **The cursor follows the mode, in both directions.** Switching to the
  // editor unmounts the button that was focused, which drops focus to the body
  // — so a keyboard reader who pressed Edit was left outside the thing they
  // just opened, and Tab started again from the top of the dialog. Leaving puts
  // the cursor back on the pencil, where it came from. Guarded on having
  // edited, so opening the dialog does not steal focus from Radix's own
  // placement.
  useEffect(() => {
    if (editing) editorRef.current?.focus();
    else if (hasEdited.current) pencilRef.current?.focus();
    hasEdited.current = editing;
  }, [editing]);

  return (
    <ResponsiveDialog open={path !== null} onOpenChange={(open) => !open && requestClose()}>
      <ResponsiveDialogContent className="max-h-[80vh] sm:max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="truncate font-mono text-sm">
            {path === null ? '' : baseName(path)}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="truncate text-xs">
            {describe(file, path)}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {editable && !editing && (
          <div className="flex justify-end px-4">
            <Button
              ref={pencilRef}
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground gap-1.5"
              onClick={enterEdit}
            >
              <Pencil className="size-(--size-icon-xs)" />
              Edit
            </Button>
          </div>
        )}

        {conflict !== null && (
          <ConflictNotice
            conflict={conflict}
            onTakeTheirs={() => void takeTheirs()}
            onKeepMine={keepMine}
            busy={save.isPending || query.isFetching}
          />
        )}

        {refusal !== null && (
          <p
            role="alert"
            className="bg-destructive/10 text-destructive mx-4 rounded-md px-3 py-2 text-sm"
          >
            {refusal}
          </p>
        )}

        <ResponsiveDialogBody className="min-h-0 flex-1 overflow-auto">
          {query.isPending ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="text-muted-foreground size-(--size-icon-md) animate-spin" />
            </div>
          ) : query.isError || file === undefined ? (
            <PreviewNote>This file couldn&apos;t be read.</PreviewNote>
          ) : editing ? (
            <textarea
              ref={editorRef}
              aria-label={`${path === null ? 'File' : baseName(path)} contents`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              // Soft wrap, and it costs nothing in fidelity: a textarea's
              // default `wrap="soft"` breaks lines for the eye only — the
              // wrapping never enters `.value`, so what is saved is still
              // exactly what was typed. `whitespace-pre` instead laid a long
              // paragraph out as one horizontal line, which on the phone
              // drawer made a document unreadable without sideways scrolling.
              className={cn(
                'text-foreground/90 border-border/60 bg-background field-sizing-content',
                'focus-visible:border-ring focus-visible:ring-ring/50 min-h-64 w-full',
                'resize-none rounded-md border px-3 py-2 font-mono text-xs',
                'whitespace-pre-wrap focus-visible:ring-[3px] focus-visible:outline-none'
              )}
            />
          ) : (
            <PreviewBody file={file} />
          )}
        </ResponsiveDialogBody>

        {editing && (
          <ResponsiveDialogFooter className="items-center gap-2 sm:justify-between">
            <span className="text-muted-foreground text-xs" aria-live="polite">
              {save.isPending
                ? 'Saving…'
                : askingDiscard
                  ? 'You haven’t saved your changes.'
                  : saved && !dirty
                    ? 'Saved'
                    : dirty
                      ? 'Not saved yet'
                      : ''}
            </span>
            <span className="flex gap-2">
              {askingDiscard ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmingDiscard(false)}
                  >
                    Keep editing
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      resetEditing();
                      onClose();
                    }}
                  >
                    Discard changes
                  </Button>
                </>
              ) : (
                <>
                  <Button type="button" variant="ghost" size="sm" onClick={leaveEdit}>
                    {dirty ? 'Discard' : 'Done'}
                  </Button>
                  {/* Dark while a conflict is on screen. The banner above
                      already offers the only save that can succeed — this one
                      still holds the commit the room has moved past, so it
                      could do nothing but lose the same race again, and two
                      save-shaped controls where one of them cannot work is a
                      choice that is not a choice. */}
                  <Button
                    type="button"
                    size="sm"
                    disabled={!dirty || save.isPending || conflict !== null}
                    onClick={() => save.mutate({ text: draft, baseCommit: base.commit })}
                  >
                    Save
                  </Button>
                </>
              )}
            </span>
          </ResponsiveDialogFooter>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/**
 * The choice a lost race puts in front of a person — never a silent overwrite,
 * and never a silent discard either.
 *
 * It names who changed the file and when, where the room could say: a conflict
 * a person can attribute is one they can resolve by talking to somebody, which
 * is usually the real fix.
 */
function ConflictNotice({
  conflict,
  onTakeTheirs,
  onKeepMine,
  busy,
}: {
  conflict: { commit: string; lastCommit: ExplorerCommit | null; again: boolean };
  onTakeTheirs: () => void;
  onKeepMine: () => void;
  busy: boolean;
}) {
  const who = conflict.lastCommit;
  const author = who === null ? 'Somebody' : who.author;
  return (
    <div
      role="alert"
      className="border-border/60 bg-muted/40 mx-4 space-y-2 rounded-md border px-3 py-2 text-sm"
    >
      {/* A second race lost while the first was being decided reads as a dead
          button if it says exactly what the banner already said. It is the same
          choice, but something really did happen — so it says what. */}
      <p>
        {conflict.again
          ? `${author} changed this file again while you were deciding, so it still isn’t saved.`
          : `${author} changed this file while you were editing it, so nothing was saved.`}
      </p>
      {who !== null && (
        // The commit's own subject, which is what makes a conflict resolvable by
        // talking to the person rather than by guessing. Member-written text,
        // rendered as text.
        <p className="text-muted-foreground text-xs">
          {who.subject} · {formatRelativeTime(who.at)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onTakeTheirs}>
          Open their version
        </Button>
        <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={onKeepMine}>
          Save mine over it
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">Opening theirs replaces what you typed here.</p>
    </div>
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
