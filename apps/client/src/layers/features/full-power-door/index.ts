/**
 * @module features/full-power-door
 *
 * The one full-power consent door — the single surface that turns on full power.
 * {@link FullPowerDoor} holds the copy and the write sequence so the two hosts
 * that mount it (the moments rail for existing users, the onboarding stage for
 * new ones) can never drift; each host passes only the heading and where
 * "Customize…" goes. {@link FullPowerDoorMoment} is the moments-rail host,
 * carrying the Control Center integration point.
 */
export { FullPowerDoor } from './ui/FullPowerDoor';
export type { FullPowerDoorProps } from './ui/FullPowerDoor';
export { FullPowerDoorMoment } from './ui/FullPowerDoorMoment';
export type { FullPowerDoorMomentProps } from './ui/FullPowerDoorMoment';
