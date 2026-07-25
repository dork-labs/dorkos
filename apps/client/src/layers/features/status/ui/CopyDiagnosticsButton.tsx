import { ClipboardCopy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
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
  const handleCopy = () => {
    void navigator.clipboard.writeText(formatDiagnostics(diagnostics));
    toast.success('Diagnostics copied to your clipboard');
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn('gap-1.5 text-xs', className)}
      onClick={handleCopy}
    >
      <ClipboardCopy className="size-3.5" aria-hidden />
      Copy diagnostics
    </Button>
  );
}
