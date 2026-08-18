import { Loader2, Check, X, MinusCircle } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { toolStatus } from '@/layers/features/conversation';

/**
 * Tool execution lifecycle states for status icon rendering.
 *
 * `neutral` is the one that is not a lifecycle phase but an absence of one: it
 * ENDED, and nobody can say how. Drawn as the muted dash the run-history panels
 * already use for a cancelled run, because the tick claims success and the cross
 * claims failure, and the whole point of this state is that neither was observed.
 * Its first caller is a background task DorkOS lost track of (DOR-1108).
 */
export type ToolIconStatus = 'pending' | 'running' | 'complete' | 'error' | 'neutral';

/** Returns the appropriate status icon for a tool execution state. */
export function getToolStatusIcon(status: ToolIconStatus): React.ReactNode {
  switch (status) {
    case 'pending':
    case 'running':
      return (
        <Loader2 className={cn('size-(--size-icon-xs) animate-spin', toolStatus({ status }))} />
      );
    case 'complete':
      return <Check className={cn('size-(--size-icon-xs)', toolStatus({ status }))} />;
    case 'error':
      return <X className={cn('size-(--size-icon-xs)', toolStatus({ status }))} />;
    case 'neutral':
      return <MinusCircle className={cn('size-(--size-icon-xs)', toolStatus({ status }))} />;
  }
}
