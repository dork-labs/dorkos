import { Button } from '@/layers/shared/ui';

interface RelayEmptyStateProps {
  /** Called when the user clicks the keystone "Add a connection" action. */
  onAddIntegration: () => void;
}

/** Full-bleed ghost preview empty state for Relay Mode A (no connections set up). */
export function RelayEmptyState({ onAddIntegration }: RelayEmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      {/* Ghost preview — faded message rows showing what the configured state looks like */}
      <div className="pointer-events-none mb-8 w-full max-w-md opacity-30 select-none">
        <div className="space-y-2">
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <div className="flex size-6 items-center justify-center rounded-full bg-blue-500/20">
                <div className="size-3 rounded-full bg-blue-500" />
              </div>
              <div className="flex-1 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">relay.agent.frontend</span>
                  <span className="text-muted-foreground text-xs">2m ago</span>
                </div>
                <p className="text-muted-foreground text-xs">Build completed successfully</p>
              </div>
            </div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <div className="flex size-6 items-center justify-center rounded-full bg-emerald-500/20">
                <div className="size-3 rounded-full bg-emerald-500" />
              </div>
              <div className="flex-1 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">relay.system.tasks.audit</span>
                  <span className="text-muted-foreground text-xs">15m ago</span>
                </div>
                <p className="text-muted-foreground text-xs">Scheduled audit run delivered</p>
              </div>
            </div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <div className="flex size-6 items-center justify-center rounded-full bg-orange-500/20">
                <div className="size-3 rounded-full bg-orange-500" />
              </div>
              <div className="flex-1 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">relay.agent.backend</span>
                  <span className="text-muted-foreground text-xs">1h ago</span>
                </div>
                <p className="text-muted-foreground text-xs">API migration task completed</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Headline, one line of why, one action — the second paragraph said
          what the button already says. */}
      <h3 className="mb-2 text-lg font-medium">Connect your agents to the world</h3>
      <p className="text-muted-foreground mb-6 max-w-sm text-center text-sm">
        Connections let people and platforms reach your agents.
      </p>

      {/* Keystone action */}
      <Button onClick={onAddIntegration}>Add a connection</Button>
    </div>
  );
}
