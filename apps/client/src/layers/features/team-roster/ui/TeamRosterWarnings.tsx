import { useState } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import type { TeamSourceWarning } from '@dorkos/shared/team-schemas';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

/**
 * What a person is told when one of the places identities come from did not
 * answer.
 *
 * Named per source, because "something went wrong" tells nobody whether the
 * missing thing is their agents or their teammates.
 *
 * **This table is the only owner of that sentence.** A warning's own `message`
 * is diagnostic — `err.message` from whatever failed, "database is locked" —
 * and it is never rendered, so no producer has to write two audiences' worth of
 * prose and no page has to guess which one it received.
 */
const SOURCE_COPY: Record<string, string> = {
  agents: "Couldn't read your agents — showing who we could.",
  authors: "Couldn't read the people on this install — showing who we could.",
  account: "Couldn't read your account, so your own name may be missing.",
  team: 'Your team lives on the DorkOS server, and there is no server here.',
  // The three activity sources. Each one says what is missing rather than
  // implying the roster is: everybody is still here, we just cannot say what
  // they are up to.
  claims: "Couldn't tell which of your agents are working right now.",
  rooms: "Couldn't read your rooms, so we can't name where an agent is working.",
  sessions: "Couldn't read recent sessions, so “last active” may be missing.",
};

/**
 * The line for a source nobody has written copy for yet.
 *
 * Source-agnostic on purpose: `source` is a wire token (`'agents'`,
 * `'authors'`, a community ref later) written for a log, and dropping one into
 * a sentence produces "Couldn't read authors", which names an implementation
 * detail at the person reading the page. The sentence stays true whatever the
 * token turns out to be, and a source worth naming earns an entry above.
 */
function copyFor(source: string): string {
  return SOURCE_COPY[source] ?? "Some of your team couldn't be loaded.";
}

export interface TeamRosterWarningsProps {
  /** The sources that did not answer. Absent or empty draws nothing. */
  warnings?: TeamSourceWarning[];
  className?: string;
}

/**
 * The degraded-roster banner.
 *
 * The roster answers 200 with whatever it could reach, so a source that failed
 * is a note above a page that still works rather than an error page instead of
 * one. Dismissible, because a person who has read it and decided to carry on
 * should not have to read it again on every filter change.
 */
export function TeamRosterWarnings({ warnings, className }: TeamRosterWarningsProps) {
  const [dismissed, setDismissed] = useState(false);

  if (!warnings || warnings.length === 0 || dismissed) return null;

  return (
    <div
      role="status"
      data-slot="team-roster-warnings"
      className={cn(
        'border-status-warning/40 bg-status-warning/10 flex items-start gap-2 rounded-lg border px-3 py-2',
        className
      )}
    >
      <TriangleAlert aria-hidden className="text-status-warning mt-0.5 size-4 shrink-0" />
      <ul className="min-w-0 flex-1 space-y-0.5 text-xs">
        {warnings.map((warning) => (
          <li key={warning.source}>{copyFor(warning.source)}</li>
        ))}
      </ul>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className="-my-0.5 shrink-0"
      >
        <X aria-hidden className="size-3" />
      </Button>
    </div>
  );
}
