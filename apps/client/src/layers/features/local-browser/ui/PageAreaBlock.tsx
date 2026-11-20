import type { ReactNode } from 'react';
import { cn } from '@/layers/shared/lib';

/** Props for {@link PageAreaBlock}. */
export interface PageAreaBlockProps {
  /** What the block says on its own, read out as the panel's status. */
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * One centred block in the Agent browser's page area, for every state with no
 * page to show (DOR-4420 spec §9): not open, opening, can't reach, another
 * chat has it, waiting elsewhere, waiting for you, couldn't show, a new empty
 * page. It takes the page's place rather than stacking above it, and keeps to
 * 360px so a wide panel doesn't stretch it into lines too long to read.
 */
export function PageAreaBlock({ title, children, className }: PageAreaBlockProps) {
  return (
    <div
      data-slot="local-browser-page-area-block"
      className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-6"
    >
      <div className={cn('w-full max-w-[360px] space-y-3', className)}>
        {title && <p className="text-sm font-medium">{title}</p>}
        {children}
      </div>
    </div>
  );
}
