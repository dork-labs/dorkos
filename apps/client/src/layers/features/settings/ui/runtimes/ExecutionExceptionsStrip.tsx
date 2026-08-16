/**
 * The fleet's answer to the cards above it: every agent that does NOT run on
 * the defaults the Runtimes tab just showed.
 *
 * It sits with the tab it belongs to. The `execution-defaults/` folder it used
 * to live in held the settings card the runtime cards replaced, and the strip
 * outlived it — the only piece of that stack the redesign kept.
 *
 * @module features/settings/ui/runtimes/ExecutionExceptionsStrip
 */
import { TriangleAlert } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  useExecutionExceptions,
  AgentAvatar,
  type ExecutionException,
} from '@/layers/entities/agent';
import { useSettingsDeepLink } from '@/layers/shared/model';
import { useProfileStore } from '@/layers/features/profile';

/** How one deviation is worded in a row's summary. */
function deviationText(field: 'runtime' | 'model' | 'effort', label: string): string {
  return field === 'effort' ? `effort ${label}` : `${field} ${label}`;
}

/** The one thing the strip can be told rather than look up for itself. */
export interface ExecutionExceptionsStripProps {
  /**
   * Exceptions to render instead of the live ones.
   *
   * **Showcase-only injection.** The strip is the fleet's own answer, so the tab
   * passes nothing and the hook below is what draws it. The dev playground has
   * no fleet to deviate from, and a component that could only be seen with a
   * server behind it is exactly the coverage gap this redesign closes (design
   * §7) — so a showcase hands it a fleet directly.
   *
   * Supplying this also turns the catalog check off: those are per-runtime
   * round-trips whose only purpose is to decide which rows are broken, and the
   * injected rows have already decided.
   */
  exceptions?: readonly ExecutionException[];
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
 * opens that agent's profile and the fix happens where the context is — on the
 * profile's root, where "Runs on" is the row this list is about.
 *
 * Opening it straight from `useProfileStore.getState()` is the same call the
 * sidebar, the agents list, the identity chip and the command palette all
 * make — opening a profile is a store action every surface reaches for, and a
 * prop threaded through the Settings dialog for this one row would be the
 * exception, not the rule.
 *
 * @param props - See {@link ExecutionExceptionsStripProps}; the live tab passes
 *   nothing.
 */
export function ExecutionExceptionsStrip({
  exceptions: injected,
}: ExecutionExceptionsStripProps = {}) {
  // Called unconditionally whatever the prop says — rules of hooks — and simply
  // not read when a showcase has supplied its own fleet.
  const live = useExecutionExceptions({ checkModels: injected === undefined });
  const exceptions = injected ?? live.exceptions;
  const settings = useSettingsDeepLink();

  function openAgent(projectPath: string) {
    // Close first: the profile opens behind this dialog, and leaving the dialog
    // up would read as the click having done nothing.
    settings.close();
    useProfileStore.getState().openProfileDocked(projectPath);
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
