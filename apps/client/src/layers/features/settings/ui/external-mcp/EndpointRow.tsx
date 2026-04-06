import { CopyButton } from '@/layers/shared/ui';

interface EndpointRowProps {
  endpoint: string;
}

/** Endpoint URL row with copy-to-clipboard control. */
export function EndpointRow({ endpoint }: EndpointRowProps) {
  return (
    <div className="space-y-2">
      <div className="min-w-0">
        <p className="text-sm font-medium">Endpoint</p>
        <p className="text-muted-foreground text-xs">MCP server URL for external agents</p>
      </div>
      <div className="flex items-center gap-1.5">
        <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-3 py-2 font-mono text-xs">
          {endpoint}
        </code>
        <CopyButton value={endpoint} />
      </div>
    </div>
  );
}
