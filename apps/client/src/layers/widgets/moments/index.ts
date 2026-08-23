/**
 * Moments rail — the single host for one-time modals, plus the priority-ranked
 * descriptors that feed it. Opens one moment at a time, at most one per app
 * launch, and stays quiet until onboarding is over. The banner counterpart for
 * standing conditions is `widgets/app-banner`.
 *
 * @module widgets/moments
 */
export { MomentHost } from './ui/MomentHost';
export { useMoments } from './model/use-moments';
export { MOMENT_PRIORITY, type MomentDescriptor } from './model/moment-descriptor';
