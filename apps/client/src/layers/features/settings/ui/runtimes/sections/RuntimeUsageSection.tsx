/**
 * The "Usage" row of a runtime card with no account registry (Codex and
 * OpenCode): its account's usage windows, or what it spent this month.
 *
 * @module features/settings/ui/runtimes/sections/RuntimeUsageSection
 */
import { IMPLICIT_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import { useAccountUsage } from '@/layers/shared/model';
import { AccountUsageBars, hasUsageToShow } from './AccountUsageBars';

/** Props for {@link RuntimeUsageSection}. */
export interface RuntimeUsageSectionProps {
  /** The runtime whose card this sits in, such as `codex`. */
  type: string;
}

/**
 * A runtime's usage, shown even with one account (spec `claude-account-ui`
 * §6.5, R7). Reads the runtime's `default` account from the usage cache the
 * card fills; renders nothing when that account has no windows and no spend.
 */
export function RuntimeUsageSection({ type }: RuntimeUsageSectionProps) {
  const { byId, byPath } = useAccountUsage(type);
  const usage = byId.get(IMPLICIT_ACCOUNT_ID) ?? byPath.values().next().value;
  if (!hasUsageToShow(usage)) return null;
  return (
    <section
      className="bg-muted/30 space-y-3 rounded-lg border p-3"
      aria-labelledby={`runtime-usage-${type}`}
    >
      <h4
        id={`runtime-usage-${type}`}
        className="text-muted-foreground text-xs font-semibold tracking-wide uppercase"
      >
        Usage
      </h4>
      <AccountUsageBars usage={usage} />
    </section>
  );
}
