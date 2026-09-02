import { useMemo } from 'react';
import { useMemoryProviderStatus } from '@/layers/entities/memory-provider-status';
import { useNotifications, type NotificationLens } from '@/layers/entities/notifications';
import { useUnattendedAutonomy } from '@/layers/entities/unattended-autonomy';

import { deadSigninRuntimes } from '../lib/dead-runtime-signins';
import { MemoryProviderBenchedBanner } from '../ui/MemoryProviderBenchedBanner';
import { RuntimeSigninBanner } from '../ui/RuntimeSigninBanner';
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
 * Memory-provider-benched descriptor — warning severity, eligible whenever the
 * backend actually serving agent memory (`activeId`) is not the one
 * `memory.provider` names (`configuredId`), per `services/memory/registry.ts`.
 *
 * Gated on `configuredId !== activeId`, deliberately NOT on `status.benched`
 * alone: a benched backend is one cause of the mismatch, but the likelier one
 * in practice — a typo'd id, or a backend module that never called
 * `registerMemoryProvider` — leaves nothing for the registry to bench either,
 * so `benched` stays `false` while the configured backend still never serves a
 * single call. Gating on the mismatch instead catches both; the banner's own
 * `benched` prop still carries which one this is, so the copy can say so.
 *
 * Warning rather than info in both cases: unlike unattended autonomy, this is
 * something an operator did not choose.
 */
function useMemoryProviderBenchedDescriptor(): BannerDescriptor | null {
  const status = useMemoryProviderStatus();
  if (!status || status.configuredId === status.activeId) return null;
  return {
    id: 'memory-provider-benched',
    variant: 'warning',
    priority: BANNER_PRIORITY.warning,
    render: () => (
      <MemoryProviderBenchedBanner configuredId={status.configuredId} benched={status.benched} />
    ),
  };
}

/**
 * The Inbox lens this widget reads: `signin.required` rows and nothing else.
 *
 * Module-level so every render asks for the same lens — the lens is the query
 * key, and its own paged request rather than a sieve over the bell's first page
 * (see `NotificationLens.kinds`), so a busy morning cannot push the one row that
 * matters off the end of a page this hook never scrolls.
 */
const SIGNIN_LENS: NotificationLens = { kinds: ['signin.required'] };

/**
 * Runtime-sign-in descriptor — critical severity, eligible while any runtime's
 * newest `signin.required` row is not a `cleared` one.
 *
 * Critical, and the only descriptor here that is: nothing on that runtime runs
 * at all — not a scheduled task at 3am, not a room reply, not an agent-to-agent
 * delivery — and unlike a benched memory backend there is no degraded path
 * carrying on behind it. It is also the one condition on this list that a person
 * can end, from the button the banner draws.
 *
 * Read from the Inbox rather than from a runtime-health endpoint because the
 * Inbox row IS the record: `signin.required` is `standing-recorded`, so the
 * server writes a row at the raise edge and another at the recovery, and the
 * memory-held watch behind them does not survive a restart. See
 * {@link deadSigninRuntimes} for why the test is `outcome`, never unread.
 */
function useRuntimeSigninDescriptor(): BannerDescriptor | null {
  const { notifications } = useNotifications(SIGNIN_LENS);
  const runtimes = useMemo(() => deadSigninRuntimes(notifications), [notifications]);
  if (runtimes.length === 0) return null;
  return {
    id: 'runtime-signin',
    variant: 'critical',
    priority: BANNER_PRIORITY.critical,
    render: () => <RuntimeSigninBanner runtimes={runtimes} />,
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
  const memoryProviderBenched = useMemoryProviderBenchedDescriptor();
  const runtimeSignin = useRuntimeSigninDescriptor();
  return [unattended, memoryProviderBenched, runtimeSignin].filter(
    (d): d is BannerDescriptor => d !== null
  );
}
