import { useState, useImperativeHandle, forwardRef } from 'react';
import { Check, X, Shield } from 'lucide-react';
import { useTransport } from '@/layers/shared/model';
import { ToolArgumentsDisplay, cn } from '@/layers/shared/lib';
import { Kbd } from '@/layers/shared/ui';

interface ToolApprovalProps {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: string;
  /** Whether this is the active shortcut target */
  isActive?: boolean;
}

export interface ToolApprovalHandle {
  approve: () => void;
  deny: () => void;
}

export const ToolApproval = forwardRef<ToolApprovalHandle, ToolApprovalProps>(function ToolApproval(
  { sessionId, toolCallId, toolName, input, isActive = false },
  ref,
) {
  const transport = useTransport();
  const [responding, setResponding] = useState(false);
  const [decided, setDecided] = useState<'approved' | 'denied' | null>(null);

  async function handleApprove() {
    if (responding || decided) return;
    setResponding(true);
    try {
      await transport.approveTool(sessionId, toolCallId);
      setDecided('approved');
    } catch (err) {
      console.error('Approval failed:', err);
    } finally {
      setResponding(false);
    }
  }

  async function handleDeny() {
    if (responding || decided) return;
    setResponding(true);
    try {
      await transport.denyTool(sessionId, toolCallId);
      setDecided('denied');
    } catch (err) {
      console.error('Deny failed:', err);
    } finally {
      setResponding(false);
    }
  }

  useImperativeHandle(ref, () => ({
    approve() { handleApprove(); },
    deny() { handleDeny(); },
  }), [responding, decided]);

  if (decided) {
    return (
      <div className={`my-1 rounded border px-3 py-2 text-sm transition-colors duration-200 ${
        decided === 'approved'
          ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400'
      }`}>
        <span className="font-mono">{toolName}</span>
        <span className="ml-2 text-xs">
          {decided === 'approved' ? 'Approved' : 'Denied'}
        </span>
      </div>
    );
  }

  return (
    <div className={cn(
      "my-1 rounded border border-amber-500/20 bg-amber-500/10 p-3 text-sm transition-all duration-200",
      isActive && "ring-2 ring-amber-500/30",
    )}>
      <div className="flex items-center gap-2 mb-2">
        <Shield className="size-(--size-icon-md) text-amber-500" />
        <span className="font-semibold">Tool approval required</span>
      </div>
      <div className="font-mono text-xs mb-2">{toolName}</div>
      {input && (
        <div className="mb-3 p-2 bg-muted rounded">
          <ToolArgumentsDisplay toolName={toolName} input={input} />
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={handleApprove}
          disabled={responding}
          className="flex items-center gap-1 rounded bg-emerald-600 px-3 py-1 max-md:py-2 text-white text-xs hover:bg-emerald-700 disabled:opacity-50 transition-colors"
        >
          <Check className="size-(--size-icon-xs)" /> Approve
          {isActive && <Kbd className="ml-1.5">Enter</Kbd>}
        </button>
        <button
          onClick={handleDeny}
          disabled={responding}
          className="flex items-center gap-1 rounded bg-red-600 px-3 py-1 max-md:py-2 text-white text-xs hover:bg-red-700 disabled:opacity-50 transition-colors"
        >
          <X className="size-(--size-icon-xs)" /> Deny
          {isActive && <Kbd className="ml-1.5">Esc</Kbd>}
        </button>
      </div>
    </div>
  );
});
