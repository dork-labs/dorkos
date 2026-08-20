import { Check, ClipboardCopy, X } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { cn, useCopyFeedback } from '@/layers/shared/lib';
import { formatDiagnostics, type SessionDiagnostics } from '../model/session-diagnostics';

interface CopyDiagnosticsButtonProps {
  /** The snapshot to serialize. */
  diagnostics: SessionDiagnostics;
  /** Extra classes for the button. */
  className?: string;
}

/** The icon: a check on success, an X on failure, the clipboard glyph otherwise. */
function DiagnosticsIcon({ copied, failed }: { copied: boolean; failed: boolean }) {
  if (copied) return <Check className="size-3.5 text-green-500" aria-hidden />;
  if (failed) return <X className="text-destructive size-3.5" aria-hidden />;
  return <ClipboardCopy className="size-3.5" aria-hidden />;
}

/** The label paired with {@link DiagnosticsIcon} — always the same word for the same state. */
function diagnosticsLabel(copied: boolean, failed: boolean): string {
  if (copied) return 'Copied';
  if (failed) return "Couldn't copy";
  return 'Copy diagnostics';
}

/**
 * Put one JSON blob describing the session on the clipboard, and say so.
 *
 * Shared by the Session panel and the Session tab so a bug report pasted from
 * either is byte-for-byte the same shape — there is one serializer
 * ({@link formatDiagnostics}) and one button.
 *
 * @param props - The snapshot to copy and optional classes.
 */
export function CopyDiagnosticsButton({ diagnostics, className }: CopyDiagnosticsButtonProps) {
  const { copied, failed, copy } = useCopyFeedback();
  const handleCopy = () => void copy(formatDiagnostics(diagnostics));

  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn('gap-1.5 text-xs', className)}
      onClick={handleCopy}
    >
      <DiagnosticsIcon copied={copied} failed={failed} />
      {diagnosticsLabel(copied, failed)}
    </Button>
  );
}
