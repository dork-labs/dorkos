import { useSessionStatus } from '../../hooks/use-session-status';
import { CwdItem } from './CwdItem';
import { PermissionModeItem } from './PermissionModeItem';
import { ModelItem } from './ModelItem';
import { CostItem } from './CostItem';
import { ContextItem } from './ContextItem';
import type { SessionStatusEvent } from '@lifeos/shared/types';

interface StatusLineProps {
  sessionId: string;
  sessionStatus: SessionStatusEvent | null;
  isStreaming: boolean;
}

export function StatusLine({ sessionId, sessionStatus, isStreaming }: StatusLineProps) {
  const status = useSessionStatus(sessionId, sessionStatus, isStreaming);

  return (
    <div
      role="toolbar"
      aria-label="Session status"
      aria-live="polite"
      className="flex flex-wrap items-center justify-center sm:justify-start gap-2 px-1 pt-2 text-xs text-muted-foreground whitespace-nowrap"
    >
      {status.cwd && (
        <>
          <CwdItem cwd={status.cwd} />
          <Separator />
        </>
      )}
      <PermissionModeItem
        mode={status.permissionMode}
        onChangeMode={(mode) => status.updateSession({ permissionMode: mode })}
      />
      <Separator />
      <ModelItem
        model={status.model}
        onChangeModel={(model) => status.updateSession({ model })}
      />
      <Separator />
      {status.costUsd !== null && (
        <>
          <CostItem costUsd={status.costUsd} />
          <Separator />
        </>
      )}
      {status.contextPercent !== null && (
        <ContextItem percent={status.contextPercent} />
      )}
    </div>
  );
}

function Separator() {
  return (
    <span className="text-muted-foreground/30" aria-hidden="true">
      &middot;
    </span>
  );
}
