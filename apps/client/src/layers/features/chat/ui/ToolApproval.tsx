import { useState, useImperativeHandle, useCallback } from 'react';
import { Check, X, Shield } from 'lucide-react';
import { useTransport } from '@/layers/shared/model';
import { ToolArgumentsDisplay, cn } from '@/layers/shared/lib';
import { Kbd } from '@/layers/shared/ui';
import { approvalState } from './message/message-variants';

interface ToolApprovalProps {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: string;
  /** Whether this is the active shortcut target */
  isActive?: boolean;
  /** Called after user approves or denies, to optimistically clear waiting state */
  onDecided?: () => void;
  /** React 19 ref-as-prop for imperative approve/deny control */
  ref?: React.Ref<ToolApprovalHandle>;
}

export interface ToolApprovalHandle {
  approve: () => void;
  deny: () => void;
}

/**
 * Tool approval card rendered when the agent requests permission to use a tool.
 *
 * Supports imperative control via `ref` (approve/deny) for keyboard shortcut integration.
 */
export function ToolApproval({
  sessionId,
  toolCallId,
  toolName,
  input,
  isActive = false,
  onDecided,
  ref,
}: ToolApprovalProps) {
  const transport = useTransport();
  const [responding, setResponding] = useState(false);
  const [decided, setDecided] = useState<'approved' | 'denied' | null>(null);

  const handleApprove = useCallback(async () => {
    if (responding || decided) return;
    setResponding(true);
    try {
      await transport.approveTool(sessionId, toolCallId);
      setDecided('approved');
      onDecided?.();
    } catch (err) {
      console.error('Approval failed:', err);
    } finally {
      setResponding(false);
    }
  }, [responding, decided, transport, sessionId, toolCallId, onDecided]);

  const handleDeny = useCallback(async () => {
    if (responding || decided) return;
    setResponding(true);
    try {
      await transport.denyTool(sessionId, toolCallId);
      setDecided('denied');
      onDecided?.();
    } catch (err) {
      console.error('Deny failed:', err);
    } finally {
      setResponding(false);
    }
  }, [responding, decided, transport, sessionId, toolCallId, onDecided]);

  useImperativeHandle(
    ref,
    () => ({
      approve() {
        handleApprove();
      },
      deny() {
        handleDeny();
      },
    }),
    [handleApprove, handleDeny]
  );

  if (decided) {
    return (
      <div
        className={cn(
          'my-1 rounded-msg-tool border px-3 py-2 text-sm transition-colors duration-200',
          approvalState({ state: decided === 'approved' ? 'approved' : 'denied' })
        )}
        data-testid="tool-approval-decided"
        data-decision={decided}
      >
        <span className="font-mono">{toolName}</span>
        <span className="ml-2 text-xs">{decided === 'approved' ? 'Approved' : 'Denied'}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'my-1 rounded-msg-tool border p-3 text-sm transition-all duration-200',
        approvalState({ state: 'pending' }),
        isActive && 'ring-2 ring-status-warning/30'
      )}
      data-testid="tool-approval"
    >
      <div className="mb-2 flex items-center gap-2">
        <Shield className="size-(--size-icon-md) text-status-warning" />
        <span className="font-semibold">Tool approval required</span>
      </div>
      <div className="mb-2 font-mono text-xs">{toolName}</div>
      {input && (
        <div className="bg-muted mb-3 rounded p-2">
          <ToolArgumentsDisplay toolName={toolName} input={input} />
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={handleApprove}
          disabled={responding}
          className="flex items-center gap-1 rounded bg-status-success px-3 py-1 text-xs text-white transition-colors hover:opacity-90 disabled:opacity-50 max-md:py-2"
        >
          <Check className="size-(--size-icon-xs)" /> Approve
          {isActive && <Kbd className="ml-1.5">Enter</Kbd>}
        </button>
        <button
          onClick={handleDeny}
          disabled={responding}
          className="flex items-center gap-1 rounded bg-status-error px-3 py-1 text-xs text-white transition-colors hover:opacity-90 disabled:opacity-50 max-md:py-2"
        >
          <X className="size-(--size-icon-xs)" /> Deny
          {isActive && <Kbd className="ml-1.5">Esc</Kbd>}
        </button>
      </div>
    </div>
  );
}
