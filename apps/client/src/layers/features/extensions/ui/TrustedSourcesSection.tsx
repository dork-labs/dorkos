/**
 * Settings → Extensions → "Trusted sources" (spec `flow-multiproject` §9.3).
 *
 * @module features/extensions/ui/TrustedSourcesSection
 */
import { Button } from '@/layers/shared/ui';
import { useTrustedSourceActions, useTrustedSources } from '@/layers/entities/extension';

/** A date as a person reads it: "Sep 29, 2026". */
function formatTrustedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The sources a person trusts, each with when and a way to stop.
 *
 * Drawn only when there is at least one: a person trusts a source from the
 * one-time offer right after turning an extension on, so an empty list would
 * be a heading with nothing to do under it. "Stop trusting" keeps each
 * extension that is on now running as that exact copy; a newer copy or a new
 * extension from the source waits for the person's yes.
 */
export function TrustedSourcesSection() {
  const { data: sources = [] } = useTrustedSources();
  const { stop, pendingSource } = useTrustedSourceActions();
  if (sources.length === 0) return null;

  return (
    <section className="space-y-3" data-testid="trusted-sources-section">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Trusted sources</h3>
        <p className="text-muted-foreground text-sm">
          Extensions DorkOS installs from these places turn on without asking. If you stop trusting
          one, the extensions from it that are on now keep running exactly as they are. Newer
          versions and anything new from it won’t run until you say yes.
        </p>
      </div>
      <ul className="divide-y rounded-xl border">
        {sources.map(({ source, trustedAt }) => (
          <li
            key={source}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate font-mono text-sm">{source}</p>
              {formatTrustedAt(trustedAt) && (
                <p className="text-muted-foreground text-xs">
                  Trusted {formatTrustedAt(trustedAt)}
                </p>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pendingSource === source}
              onClick={() => stop(source)}
            >
              Stop trusting
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
