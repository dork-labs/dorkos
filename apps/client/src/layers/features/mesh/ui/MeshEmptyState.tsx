import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/layers/shared/ui';

interface MeshEmptyStateProps {
  icon: LucideIcon;
  headline: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  /** Optional faded preview element rendered above the headline. */
  preview?: ReactNode;
}

/** Reusable empty state for Mesh panel tabs — icon, headline, description, optional preview, and optional CTA. */
export function MeshEmptyState({
  icon: Icon,
  headline,
  description,
  action,
  preview,
}: MeshEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
      {preview && (
        <div className="pointer-events-none mb-4 w-full max-w-sm opacity-40 select-none">
          {preview}
        </div>
      )}
      <div className="bg-muted/50 rounded-xl p-3">
        <Icon className="text-muted-foreground size-6" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{headline}</p>
        <p className="text-muted-foreground max-w-[280px] text-xs">{description}</p>
      </div>
      {action && (
        <Button size="sm" onClick={action.onClick} className="mt-1">
          {action.label}
        </Button>
      )}
    </div>
  );
}

/** Mini faded topology preview for the agents empty state. */
export function TopologyPreview() {
  return (
    <div className="flex items-center justify-center gap-6">
      {/* Node 1 */}
      <div className="flex flex-col items-center gap-1">
        <div className="bg-background flex size-10 items-center justify-center rounded-lg border">
          <span className="text-sm">A</span>
        </div>
        <span className="text-muted-foreground text-[10px]">frontend</span>
      </div>
      {/* Edge */}
      <div className="bg-border h-px w-8" />
      {/* Node 2 */}
      <div className="flex flex-col items-center gap-1">
        <div className="bg-background flex size-10 items-center justify-center rounded-lg border">
          <span className="text-sm">B</span>
        </div>
        <span className="text-muted-foreground text-[10px]">backend</span>
      </div>
      {/* Edge */}
      <div className="bg-border h-px w-8" />
      {/* Node 3 */}
      <div className="flex flex-col items-center gap-1">
        <div className="bg-background flex size-10 items-center justify-center rounded-lg border">
          <span className="text-sm">C</span>
        </div>
        <span className="text-muted-foreground text-[10px]">shared</span>
      </div>
    </div>
  );
}
