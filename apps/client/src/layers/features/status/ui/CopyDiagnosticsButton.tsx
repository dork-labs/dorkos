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
      {copied ? (
        <Check className="size-3.5 text-green-500" aria-hidden />
      ) : failed ? (
        <X className="text-destructive size-3.5" aria-hidden />
      ) : (
        <ClipboardCopy className="size-3.5" aria-hidden />
      )}
      {copied ? 'Copied' : failed ? "Couldn't copy" : 'Copy diagnostics'}
    </Button>
  );
}
