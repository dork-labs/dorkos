/**
 * Where this agent's cheap checks run, what they used today, and — once, for
 * the owner of a linked computer — the offer to run them on DorkOS credits
 * (spec `heartbeats` §6.3, §7.6).
 *
 * The line is the server's live state, never the configured choice: credits
 * that dropped out read as the agent's own runtime. **Use credits** is the only
 * thing that starts spending; **Not now** closes the offer.
 *
 * @module features/profile/ui/heartbeat/HeartbeatChecks
 */
import type { HeartbeatChecks as Checks } from '@dorkos/shared/heartbeat-schemas';
import { useChooseTriageCredits } from '@/layers/entities/heartbeat';
import { Button } from '@/layers/shared/ui';
import { checksSentence, checksUsageWords } from '../../lib/checks-words';

/** The one-time offer, with its two answers. */
function CreditsOffer() {
  const choose = useChooseTriageCredits();
  return (
    <div
      className="bg-muted/40 space-y-2 rounded-md border px-3 py-3"
      data-slot="heartbeat-credits-offer"
    >
      <p className="text-sm font-medium">Run cheap checks on DorkOS credits?</p>
      <p className="text-muted-foreground text-xs">
        Quick checks skip most full runs. Nothing is spent until you say yes.
      </p>
      <div className="flex gap-2">
        <Button size="sm" disabled={choose.isPending} onClick={() => choose.mutate(true)}>
          Use credits
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={choose.isPending}
          onClick={() => choose.mutate(false)}
        >
          Not now
        </Button>
      </div>
      {choose.isError && (
        <p role="alert" className="text-destructive text-xs">
          Couldn’t save your answer. Try again.
        </p>
      )}
    </div>
  );
}

/** Props for {@link HeartbeatChecks}. */
export interface HeartbeatChecksProps {
  /** The agent's checks block. */
  checks: Checks;
}

/** "Checks run on …", today's use, and the offer when it stands. */
export function HeartbeatChecks({ checks }: HeartbeatChecksProps) {
  const usage = checksUsageWords(checks);
  return (
    <section className="space-y-2" data-slot="heartbeat-checks">
      <h3 className="text-sm font-semibold">Checks</h3>
      <p className="text-sm">{checksSentence(checks)}</p>
      {usage && <p className="text-muted-foreground text-xs">{usage}</p>}
      {checks.offer && <CreditsOffer />}
    </section>
  );
}
