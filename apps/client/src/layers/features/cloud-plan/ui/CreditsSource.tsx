import { Button, FieldCard, FieldCardContent } from '@/layers/shared/ui';
import { useCloudCredits, useSelectCloudCredits } from '../model/use-cloud-plan';

/**
 * Choosing DorkOS credits as the inference source.
 *
 * **This renders only where the server says the path is armed**, which is off by
 * default: it needs the server's own feature flag set beside the account link,
 * and neither alone arms anything. On every other install the block is absent
 * rather than disabled, because an affordance nobody can use is worse than no
 * affordance.
 *
 * It says plainly which runtimes the choice actually reaches. Two of the three
 * need a design decision on the DorkOS side before they can, and saying so is
 * the honest version of shipping this — a switch that silently did nothing for
 * two of a person's three runtimes would be a lie about where their money goes.
 */
export function CreditsSource() {
  const { data } = useCloudCredits();
  const select = useSelectCloudCredits();

  if (!data?.enabled) return null;

  const pending = Object.entries(data.runtimes)
    .filter(([, state]) => state === 'follow-up')
    .map(([runtime]) => runtime);

  return (
    <FieldCard>
      <FieldCardContent className="space-y-3">
        <div>
          <p className="text-muted-foreground text-xs tracking-wide uppercase">Inference source</p>
          <p className="text-sm">
            {data.ready
              ? 'Turns run on your DorkOS credits.'
              : 'Run turns on your DorkOS credits instead of your own key.'}
          </p>
        </div>
        {pending.length > 0 && (
          <p className="text-muted-foreground text-xs">
            {pending.join(' and ')} still run on whatever you have set up for them.
          </p>
        )}
        <Button
          size="sm"
          variant={data.ready ? 'outline' : 'default'}
          disabled={select.isPending}
          onClick={() => select.mutate()}
        >
          {data.ready ? 'Refresh' : 'Use my credits'}
        </Button>
      </FieldCardContent>
    </FieldCard>
  );
}
