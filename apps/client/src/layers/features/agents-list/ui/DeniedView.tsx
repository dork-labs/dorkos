import { Loader2, ShieldCheck } from 'lucide-react';
import { useDeniedAgents } from '@/layers/entities/mesh';
import { MeshEmptyState } from '@/layers/features/mesh';
import { Badge } from '@/layers/shared/ui';

/** Denied agents view — shows blocked paths with denial metadata. */
export function DeniedView() {
  const { data: deniedResult, isLoading } = useDeniedAgents();
  const denied = deniedResult?.denied ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  if (denied.length === 0) {
    return (
      <MeshEmptyState
        icon={ShieldCheck}
        headline="No blocked paths"
        description="When you deny agent paths during discovery, they appear here. This is a healthy state."
      />
    );
  }

  return (
    <div className="space-y-2 p-4">
      {denied.map((d) => (
        <div key={d.path} className="flex items-center justify-between rounded-xl border px-4 py-3">
          <div>
            <p className="font-mono text-sm">{d.path}</p>
            {d.reason && <p className="text-muted-foreground text-xs">{d.reason}</p>}
          </div>
          <Badge variant="outline" className="text-xs">
            {d.deniedBy}
          </Badge>
        </div>
      ))}
    </div>
  );
}
