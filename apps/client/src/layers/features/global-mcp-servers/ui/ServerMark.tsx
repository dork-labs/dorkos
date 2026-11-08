import { Server } from 'lucide-react';

/** The square mark every MCP server wears: they have no logo of their own. */
export function ServerMark() {
  return (
    <span
      aria-hidden
      className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg"
    >
      <Server className="size-(--size-icon-md)" />
    </span>
  );
}
