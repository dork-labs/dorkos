/**
 * The skill-packs installed for one agent, as a list.
 *
 * @module entities/marketplace/ui/SkillPacksList
 */
import { useInstalledPackages } from '../model/use-installed-packages';
import { ScopeBadge } from './ScopeBadge';

export interface SkillPacksListProps {
  /** The agent's project directory — what "installed for this agent" is scoped to. */
  projectPath: string;
}

/**
 * What this agent knows how to do, and where each pack was installed from.
 *
 * Entity UI: a path in, a list out. The profile's Skills page draws it today,
 * and no surface owns the shape of a row — that is what keeps a second one
 * from drifting.
 */
export function SkillPacksList({ projectPath }: SkillPacksListProps) {
  const { data: packages, isLoading, error } = useInstalledPackages(projectPath);

  if (isLoading) {
    return <p className="text-muted-foreground py-2 text-xs">Loading skills…</p>;
  }

  if (error) {
    return <p className="text-destructive py-2 text-xs">Couldn&rsquo;t load skills.</p>;
  }

  const skillPacks = packages?.filter((p) => p.type === 'skill-pack') ?? [];

  if (skillPacks.length === 0) {
    return (
      <p className="text-muted-foreground py-2 text-xs">
        No skills installed. Browse the marketplace to add skills to this agent.
      </p>
    );
  }

  return (
    <ul className="space-y-1.5 py-1">
      {skillPacks.map((pkg) => (
        <li key={pkg.name} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{pkg.name}</span>
          {pkg.version && (
            <span className="text-muted-foreground text-3xs shrink-0">v{pkg.version}</span>
          )}
          <ScopeBadge scope={pkg.scope} />
        </li>
      ))}
    </ul>
  );
}
