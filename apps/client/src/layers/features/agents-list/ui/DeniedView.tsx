import { ShieldCheck } from 'lucide-react';
import { useDeniedAgents } from '@/layers/entities/mesh';
import { Badge, EmptyState, Spinner } from '@/layers/shared/ui';

/** Denied agents view — shows blocked paths with denial metadata. */
export function DeniedView() {
  const { data: deniedResult, isLoading } = useDeniedAgents();
  const denied = deniedResult?.denied ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner size="md" className="text-muted-foreground" label="Loading blocked paths" />
      </div>
    );
  }

  if (denied.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        headline="No blocked paths"
        description="When you deny agent paths during discovery, they appear here. This is a healthy state."
      />
    );
  }

  return (
    <div className="space-y-2 p-4">
      {denied.map((d) => (
        <div
          key={d.path}
          className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3"
        >
          {/* `min-w-0` on the text column, or the path — one unbroken string —
              sizes the column from its own content and pushes the badge off
              the card (DOR-1747). The full path is on hover; the tail is the
              part that identifies it, but a folder name is not worth a second
              line here. */}
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-sm" title={d.path}>
              {d.path}
            </p>
            {d.reason && (
              <p className="text-muted-foreground truncate text-xs" title={d.reason}>
                {d.reason}
              </p>
            )}
          </div>
          {/* `shrink-0`, or the badge gives its width up to the path beside it
              and wraps its own single word (DOR-1747). */}
          <Badge variant="outline" className="shrink-0">
            {d.deniedBy}
          </Badge>
        </div>
      ))}
    </div>
  );
}
