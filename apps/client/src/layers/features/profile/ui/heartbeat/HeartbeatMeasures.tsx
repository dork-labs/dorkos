/**
 * The Heartbeat page's measures (spec `heartbeats` §13): whether this agent's
 * work on its own helped, and what it cost people's attention. Each number
 * says where it comes from, and sits beside its starting target. A target is a
 * bet to compare against, never a grade, so nothing here is colored good or bad.
 *
 * @module features/profile/ui/heartbeat/HeartbeatMeasures
 */
import type { HeartbeatMeasures as Measures } from '@dorkos/shared/heartbeat-schemas';
import { MoreDetails } from '@/layers/shared/ui';
import {
  interruptionsWords,
  mutesDetailWords,
  noChecksWords,
  partOfWords,
  percentWords,
  supportingLines,
  targetWords,
  windowWords,
} from '../../lib/measures-words';

/** One measure: its name, its number, how it was counted, and its target. */
function MeasureRow({
  label,
  value,
  detail,
  target,
  source,
}: {
  label: string;
  value: string;
  detail?: string | null;
  target?: string;
  source: string;
}) {
  return (
    <div
      data-slot="heartbeat-measure"
      className="grid grid-cols-[1fr_auto] items-baseline gap-x-2 gap-y-0.5 py-1.5"
    >
      <dt className="text-sm">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{value}</dd>
      {(detail || target) && (
        <dd className="text-muted-foreground col-span-2 flex flex-wrap gap-x-2 text-xs">
          {detail && <span className="tabular-nums">{detail}</span>}
          {target && <span>{targetWords(target)}</span>}
        </dd>
      )}
      <dd className="text-muted-foreground col-span-2 text-xs">{source}</dd>
    </div>
  );
}

/** Mutes and pauses: shown with or without checks, since a pause can be why there are none. */
function MutesRow({ measures }: { measures: Measures }) {
  const { mutesAndPauses } = measures;
  return (
    <MeasureRow
      label="Mutes and pauses"
      value={String(mutesAndPauses.total)}
      detail={mutesDetailWords(measures)}
      target={mutesAndPauses.target}
      source={mutesAndPauses.source}
    />
  );
}

/** Props for {@link HeartbeatMeasures}. */
export interface HeartbeatMeasuresProps {
  /** The agent's measures. */
  measures: Measures;
}

/** The five measures, then the supporting ones behind "More details". */
export function HeartbeatMeasures({ measures }: HeartbeatMeasuresProps) {
  const nothing = 'Nothing to count yet';
  if (measures.supporting.beats === 0) {
    return (
      <section className="space-y-1" data-slot="heartbeat-measures" data-state="empty">
        <h3 className="text-sm font-semibold">Measures</h3>
        <p className="text-muted-foreground text-sm">{noChecksWords(measures)}</p>
        <dl>
          <MutesRow measures={measures} />
        </dl>
      </section>
    );
  }
  const { keptRate, usefulRaiseRate, interruptions } = measures;
  const supporting = supportingLines(measures);
  return (
    <section className="space-y-2" data-slot="heartbeat-measures" data-state="measured">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">Measures</h3>
        <p className="text-muted-foreground text-xs">
          {windowWords(measures)} Targets are starting points, not grades.
        </p>
      </div>
      <dl className="divide-y">
        <MeasureRow
          label="Work that stuck"
          value={percentWords(keptRate) ?? nothing}
          detail={keptRate.whole > 0 ? partOfWords(keptRate) : null}
          target={keptRate.target}
          source={keptRate.source}
        />
        <MeasureRow
          label="Useful messages"
          value={percentWords(usefulRaiseRate) ?? nothing}
          detail={usefulRaiseRate.whole > 0 ? partOfWords(usefulRaiseRate) : null}
          target={usefulRaiseRate.target}
          source={usefulRaiseRate.source}
        />
        <MeasureRow
          label="Interruptions per useful outcome"
          value={interruptionsWords(interruptions) ?? nothing}
          detail={
            interruptions.value === null
              ? null
              : `${interruptions.messages} sent, ${interruptions.usefulOutcomes} useful`
          }
          target={interruptions.target}
          source={interruptions.source}
        />
        <MeasureRow label="Surprises" value="Not measured yet" source={measures.surprises.source} />
        <MutesRow measures={measures} />
      </dl>
      {supporting.length > 0 && (
        <MoreDetails label="Supporting measures" openLabel="Fewer measures">
          <ul className="space-y-1 text-xs" aria-label="Supporting measures">
            {supporting.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </MoreDetails>
      )}
    </section>
  );
}
