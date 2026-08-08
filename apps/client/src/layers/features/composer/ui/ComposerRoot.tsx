import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import { useDragAndPaste, usePathDrop } from './use-drag-and-paste';

/** Chat's card chrome, which every surface now shares. */
const CARD_CHROME = 'bg-surface relative m-2 rounded-xl border p-2';

/**
 * Every prop the composer's card accepts.
 *
 * Exported because the `Composer` namespace object in the barrel infers its
 * type from this component; it is NOT part of the slice's public surface —
 * consumers pass props at the JSX site, they never name this type.
 */
export interface ComposerRootProps {
  /** The composer's contents — the overlay lane, attachments, and text field. */
  children: React.ReactNode;
  /**
   * Accept dropped and pasted files. Given => the card mounts the dropzone,
   * renders the hidden file input, and shows the "Drop files to attach"
   * overlay. Omitted => no dropzone is mounted at all.
   */
  onFilesDropped?: (files: File[]) => void;
  /**
   * Accept a file dragged out of the file tree. Given => a dropped file
   * reference arrives here as its working-directory-relative path, instead of
   * being treated as an upload. Omitted => the card ignores those drops.
   *
   * Separate from `onFilesDropped` because it is a different event with a
   * different answer: the tree drags a reference to a file the machine already
   * has, so the surface writes it into the message rather than uploading it.
   */
  onPathDropped?: (path: string) => void;
  /** Merged after the card's own classes, so a caller can override them. */
  className?: string;
}

/**
 * The card chrome every composer sits in, and the only place attach is plumbed.
 *
 * `relative` is load-bearing, not decoration: `Composer.OverlayLane` anchors to
 * this element with `bottom-full`, so the lane is only ever positioned
 * correctly inside this card.
 *
 * Anything a single surface needs arrives as a CHILD and is never baked in
 * here. Chat's `ScanLine` streaming edge is the case that decides it: it is
 * chat-only, so chat renders it inside `Composer.Root` rather than Root
 * learning what streaming is. Same for the safe-area padding — see the
 * `className` note below.
 *
 * Passing `onFilesDropped` is the whole attach declaration. There is no
 * `canAttach` flag, because a flag could disagree with what is on screen:
 * a surface accepts files because it wired the handler, full stop.
 */
export function ComposerRoot({
  children,
  onFilesDropped,
  onPathDropped,
  className,
}: ComposerRootProps) {
  // Not a conditional hook and deliberately not a no-op handler either.
  // `useDragAndPaste` calls `useDropzone`, which attaches document-level drag
  // listeners; mounting that on every room and thread composer with no attach
  // wiring would be a real behavior change, not a harmless one. Two components,
  // picked by whether the handler exists, is the only version of this that both
  // obeys the rules of hooks and stays honest about what is listening.
  if (onFilesDropped) {
    return (
      <DropCapableCard
        onFilesDropped={onFilesDropped}
        onPathDropped={onPathDropped}
        className={className}
      >
        {children}
      </DropCapableCard>
    );
  }

  return (
    <ComposerCard onPathDropped={onPathDropped} className={className}>
      {children}
    </ComposerCard>
  );
}

/**
 * The card chrome, verbatim from chat's composer.
 *
 * The caller's `className` merges last so it can override, and so non-Tailwind
 * tokens survive: chat passes `chat-input-container`, which carries the
 * notched-device safe-area inset in `index.css`. That rule rides on this very
 * element, and it stays the CALLER's to apply — a card that baked it in would
 * push every room and dashboard composer off the bottom of a phone.
 */
function ComposerCard({
  children,
  onPathDropped,
  className,
}: {
  children: React.ReactNode;
  onPathDropped?: (path: string) => void;
  className?: string;
}) {
  const pathDrop = usePathDrop(onPathDropped);

  return (
    // A drop target is not a control: there is nothing here to focus or
    // activate, and a keyboard reaches the same file through the composer's own
    // `@` picker. react-dropzone's root carries these very handlers on a plain
    // div for the same reason.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className={cn(CARD_CHROME, className)}
      onDragOver={pathDrop?.onDragOver}
      onDrop={pathDrop ? (e) => void pathDrop.onDrop(e) : undefined}
    >
      {children}
    </div>
  );
}

/** The same card, plus the dropzone, hidden file input, and drop overlay. */
function DropCapableCard({
  children,
  onFilesDropped,
  onPathDropped,
  className,
}: {
  children: React.ReactNode;
  onFilesDropped: (files: File[]) => void;
  onPathDropped?: (path: string) => void;
  className?: string;
}) {
  const { getRootProps, getInputProps, isDragActive, handlePaste } = useDragAndPaste({
    onFilesSelected: onFilesDropped,
  });
  const pathDrop = usePathDrop(onPathDropped);
  const rootProps = getRootProps();

  return (
    // Same reasoning as `ComposerCard`; `rootProps` already sets the role
    // react-dropzone chose, which the rule cannot see through the spread.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      {...rootProps}
      // Composed by hand rather than handed to react-dropzone: its own drop
      // handler calls `preventDefault` before anything else runs, so a handler
      // passed through `getRootProps` would never be reached. A file reference
      // is consumed here; everything else falls through to the upload path
      // exactly as before.
      onDragOver={(e) => {
        pathDrop?.onDragOver(e);
        rootProps.onDragOver?.(e);
      }}
      onDrop={(e) => {
        if (pathDrop?.onDrop(e)) return;
        rootProps.onDrop?.(e);
      }}
      onPaste={handlePaste}
      className={cn(CARD_CHROME, className)}
    >
      <input {...getInputProps()} />

      <AnimatePresence>
        {isDragActive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="bg-primary/10 border-primary absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed"
          >
            <p className="text-primary text-sm font-medium">Drop files to attach</p>
          </motion.div>
        )}
      </AnimatePresence>

      {children}
    </div>
  );
}
