import { Loader2, Check, X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { toolStatus } from '../message/message-variants';

/** Tool execution lifecycle states for status icon rendering. */
export type ToolIconStatus = 'pending' | 'running' | 'complete' | 'error';

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
  }
}
