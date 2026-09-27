import type { ImpactApp } from '../lib/connection-impact';

/** One app line: its name and, when any, how many agents use it. */
function AppLine({ app }: { app: ImpactApp }) {
  return (
    <li>
      {app.name}
      {app.agentCount > 0 && (
        <span className="text-muted-foreground">
          {' '}
          · used by {app.agentCount} {app.agentCount === 1 ? 'agent' : 'agents'}
        </span>
      )}
    </li>
  );
}

/**
 * The apps a destructive change touches, in two honest groups: the ones that
 * work now and will stop, and the ones that can't be used now anyway (paused,
 * or on a way that already isn't working). Renders nothing when both are empty.
 */
export function ConnectionImpactList({
  stopping,
  idle,
  stopLine,
}: {
  /** Apps that work now and will stop. */
  stopping: readonly ImpactApp[];
  /** Apps that can't be used now anyway. */
  idle: readonly ImpactApp[];
  /** The sentence over the stopping list, e.g. "These 2 apps will stop working for every agent:". */
  stopLine: string;
}) {
  if (stopping.length === 0 && idle.length === 0) return null;
  const listClass = 'text-foreground max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-sm';
  return (
    <div className="space-y-3 text-sm" data-testid="connection-impact-list">
      {stopping.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-muted-foreground">{stopLine}</p>
          <ul className={listClass}>
            {stopping.map((app) => (
              <AppLine key={app.connectionId} app={app} />
            ))}
          </ul>
        </div>
      )}
      {idle.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-muted-foreground">
            {idle.length === 1 ? 'This app' : `These ${idle.length} apps`} can’t be used now either
            way:
          </p>
          <ul className={listClass}>
            {idle.map((app) => (
              <AppLine key={app.connectionId} app={app} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
