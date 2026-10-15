import { Button } from '@/layers/shared/ui';

import type { SharedApp } from '../model/use-shared-apps';

/** Props for {@link SharedAppsList}. */
export interface SharedAppsListProps {
  /** The apps still shared with every agent. */
  apps: readonly SharedApp[];
  /** Open one app's "Who can use it?" on "Only agents you pick". */
  onChooseAgents: (connectionId: string) => void;
  /** Whether an answer is being saved. */
  disabled: boolean;
}

/**
 * The apps the Trusted upgrade shared with every agent, each with a way to
 * narrow it (spec `trusted-by-default-flip` §5.8, decision D1).
 *
 * @param props - See {@link SharedAppsListProps}.
 */
export function SharedAppsList({ apps, onChooseAgents, disabled }: SharedAppsListProps) {
  return (
    <div className="space-y-1 text-sm" data-testid="trust-notice-shared-apps">
      <p className="text-muted-foreground">Shared with every agent:</p>
      <ul className="space-y-0.5">
        {apps.map((app) => (
          <li key={app.connectionId} className="flex items-center justify-between gap-2">
            <span>{app.name}</span>
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              disabled={disabled}
              aria-label={`Choose agents for ${app.name}`}
              onClick={() => onChooseAgents(app.connectionId)}
            >
              Choose agents
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
