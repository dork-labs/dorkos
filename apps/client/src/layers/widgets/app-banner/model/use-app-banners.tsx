import { useUnattendedAutonomy } from '@/layers/entities/unattended-autonomy';

import { UnattendedAutonomyBanner } from '../ui/UnattendedAutonomyBanner';
import { BANNER_PRIORITY, type BannerDescriptor } from './banner-descriptor';

/**
 * Unattended-autonomy descriptor — info severity, eligible whenever at least one
 * live binding or scheduled task is set to run at full power. Reads the server's
 * single cheap aggregate rather than the binding and task lists, which is what
 * lets a banner about them be app-wide at all.
 *
 * Info and not warning: full power is a chosen, expected state after the
 * defaults flip, and a permanent amber row over a normal setting is how a person
 * learns to stop reading the row (spec `full-power-defaults`, D8). The variant
 * here mirrors the rendered banner's on purpose — the slot ranks descriptors, so
 * the two disagreeing would rank this against other banners at a severity it
 * does not draw.
 */
function useUnattendedAutonomyDescriptor(): BannerDescriptor | null {
  const state = useUnattendedAutonomy();
  if (!state || state.drivers.length === 0) return null;
  return {
    id: 'unattended-autonomy',
    variant: 'info',
    priority: BANNER_PRIORITY.info,
    render: () => <UnattendedAutonomyBanner drivers={state.drivers} />,
  };
}

/**
 * Collects every eligible app banner for the current app state. The slot ranks
 * the result and shows the highest-priority one. Add a banner by writing a
 * descriptor hook and appending its result here — no other wiring is required.
 *
 * ## The bypass banner that used to live here
 *
 * A session running with every permission bypassed raised a standing app-wide
 * banner. It is gone (spec `trust-dial`, decision 3A): it said the same thing the
 * status strip already says, in a second voice, about a session the person was
 * sitting in front of — and two alarms for one fact teach people to read neither.
 * The signal now lives where the setting does: the strip's word and tint, and the
 * per-row glyph in the session list.
 *
 * The case it WAS right about — **unattended** autonomy, an agent left running
 * without asking behind a relay binding or a scheduled task, where nobody is
 * watching a strip — is the descriptor above (DOR-814). It could not simply be
 * narrowed into place: the old banner only ever read the session in front of the
 * person, so the unattended case needed binding and task state this widget must
 * not fetch on every route, plus its own definition of unattended. Both now live
 * on the server (`services/core/unattended-autonomy/`), which is why
 * this hook reads one small aggregate and no lists.
 *
 * ## The telemetry banner that used to live here
 *
 * The first-run telemetry invitation was a neutral banner in this slot. It is
 * now a one-time modal on the moments rail (`widgets/moments`, spec
 * `full-power-defaults` D5): it asks a yes/no question, and this slot is for
 * standing conditions, not questions — so it sat above every route for as long
 * as the user kept not answering it. Nothing about the question or what it
 * writes changed; only where it is asked.
 *
 * @param sessionId - The active session id, or null when none is selected.
 */
export function useAppBanners(_sessionId: string | null): BannerDescriptor[] {
  const unattended = useUnattendedAutonomyDescriptor();
  return [unattended].filter((d): d is BannerDescriptor => d !== null);
}
