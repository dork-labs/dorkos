/** Honest unavailable state for server-owned Connections surfaces in embedded mode. */
export function EmbeddedConnectionsNotice({
  title,
}: {
  /** Short surface label. */ title: string;
}) {
  return (
    <div className="bg-muted/40 rounded-lg p-4" role="status">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground mt-1 text-xs">
        Connections can only be managed in DorkOS itself. Open DorkOS in your browser to connect
        services.
      </p>
    </div>
  );
}
