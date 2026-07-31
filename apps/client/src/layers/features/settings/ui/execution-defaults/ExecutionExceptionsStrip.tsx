import { TriangleAlert } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { useExecutionExceptions, AgentAvatar } from '@/layers/entities/agent';
import { useAppStore, useSettingsDeepLink } from '@/layers/shared/model';
import { useAgentHubStore } from '@/layers/features/agent-hub';

/** How one deviation is worded in a row's summary. */
function deviationText(field: 'runtime' | 'model' | 'effort', label: string): string {
  return field === 'effort' ? `effort ${label}` : `${field} ${label}`;
}

/**
 * Every agent that does not run on the defaults above, broken ones first.
 *
 * Deliberately read-only and deliberately quiet: a fleet where everything
 * inherits shows nothing at all, so the strip only ever appears when there is
 * something to say (spec `execution-defaults` §5). Broken rows come first in
 * warning color — a runtime that is not connected, a model that is gone, an
 * effort on a runtime that has none — because those are the ones that stopped
 * working rather than the ones somebody chose.
 *
 * A row is a link, not an editor. Fixing one thing in a list of exceptions
 * always turns into wanting to see the rest of that agent's settings, so the row
 * opens the agent's own Config tab and the fix happens where the context is.
 *
 * Opening the hub straight from `useAgentHubStore.getState()` is the same call
 * the sidebar, the agents list, the identity chip and the command palette all
 * make — the hub's open intent is a store action every surface reaches for, and
 * a prop threaded through the Settings dialog for this one row would be the
 * exception, not the rule.
 */
export function ExecutionExceptionsStrip() {
  const { exceptions } = useExecutionExceptions({ checkModels: true });
  const settings = useSettingsDeepLink();
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const setActiveRightPanelTab = useAppStore((s) => s.setActiveRightPanelTab);

  function openAgent(projectPath: string) {
    // All three, in this order, and every one of them is load-bearing — the same
    // trio the sidebar's "open profile" and the agents list's "manage" do.
    // `openHub` alone only says WHICH agent; without the panel being opened and
    // pointed at the hub tab, the dialog closes onto an unchanged dashboard and
    // the click reads as having done nothing.
    settings.close();
    useAgentHubStore.getState().openHub(projectPath, 'config');
    setActiveRightPanelTab('agent-hub');
    setRightPanelOpen(true);
  }

  if (exceptions.length === 0) return null;

  return (
    <div className="space-y-1" data-testid="execution-exceptions-strip">
      <p className="text-muted-foreground px-1 text-xs">These agents run on something else:</p>
      <ul className="divide-border bg-card divide-y overflow-hidden rounded-lg border">
        {exceptions.map(({ path, agent, report }) => {
          const reason = report.isBroken
            ? report.breakages.map((b) => b.message).join(' ')
            : report.deviations.map((d) => deviationText(d.field, d.label)).join(', ');
          return (
            <li key={path}>
              <button
                type="button"
                onClick={() => openAgent(path)}
                className="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left transition-colors"
                data-testid={report.isBroken ? 'execution-exception-broken' : 'execution-exception'}
              >
                <AgentAvatar
                  color={agent.color ?? '#888'}
                  emoji={agent.icon ?? '\u{1F916}'}
                  size="xs"
                />
                {/* Stacked on a phone, side by side from `sm` up. A single line
                  at 390px put the name at three letters and ran the reason off
                  the right edge — and the reason is the whole point of the row.
                  Every level carries `min-w-0`, without which a flex child
                  refuses to shrink below its content and no clamp ever engages.
                  Aligned to the top rather than centered because the reason is
                  the taller half whenever it takes both its lines. */}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-start sm:gap-3">
                  <span className="truncate text-sm font-medium sm:pt-px">{agent.name}</span>
                  <span
                    className={cn(
                      'flex min-w-0 items-start gap-1.5 text-xs sm:ml-auto sm:max-w-[65%]',
                      report.isBroken
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-muted-foreground'
                    )}
                  >
                    {report.isBroken && (
                      <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                    )}
                    {/* Two breakages join into a sentence pair, and one truncated
                      line cut them at "does nothi…" — the row's only content,
                      unreadable. Two lines hold the pair at every width the strip
                      is drawn at, and `title` carries whatever a third would push
                      past them, so nothing is ever only half-said. */}
                    <span className="line-clamp-2" title={reason}>
                      {reason}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
