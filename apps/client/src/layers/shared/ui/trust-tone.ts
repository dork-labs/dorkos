/**
 * What colour a trust setting reads in, written once for every surface that
 * draws one.
 *
 * ## The colour economy
 *
 * Green is the reward, not the alarm. A person who put an agent at Full autonomy
 * chose the product's headline capability, and a surface that answers that
 * choice in red is telling them they did something wrong — which is both untrue
 * and the fastest way to teach people that red means nothing. So the top stop
 * reads in the success token, the safe stops read plain, and red is left for the
 * things that genuinely are alarms: quarantine, rules the product cannot read,
 * errors, and the destructive confirmations elsewhere in the app.
 *
 * Amber keeps the one job it already had — a runtime that asks LESS often than
 * the stop it sits at promised ({@link isDivergent}). That is information, not
 * severity, and it is the reason there are three tones here rather than two.
 *
 * ## Derived from semantics, never from a mode id
 *
 * Every answer comes from what the runtime declared about the mode — its `stop`,
 * and whether it keeps that stop's asking promise. A `mode === 'bypassPermissions'`
 * anywhere near a colour is the id-table bug `permission-semantics` exists to
 * end: it would paint Claude's autonomy stop and leave Codex's `danger-full-access`
 * plain, and the next runtime's spelling would be wrong again.
 *
 * @module shared/ui/trust-tone
 */
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { isAutonomyStop, isDivergent } from '@/layers/shared/lib';

/**
 * How a trust setting reads on screen.
 *
 * - `'power'` — the dial's top stop. Full power, and it looks like it.
 * - `'divergent'` — this runtime asks less often than the stop promised.
 * - `'neutral'` — nothing to mark. The safe stops resting quietly.
 */
export type TrustTone = 'power' | 'divergent' | 'neutral';

/**
 * The text colour each tone paints, on the semantic tokens so both themes and
 * the Obsidian bridge stay calibrated.
 *
 * `'neutral'` is the muted foreground, which is right for a caption that owns
 * its whole colour. A surface that inherits its colour from a line around it —
 * the status strip — should paint only `'power'` and leave the rest alone; see
 * {@link trustToneAccent}.
 */
export const TRUST_TONE_TEXT: Record<TrustTone, string> = {
  power: 'text-status-success',
  divergent: 'text-amber-600 dark:text-amber-400',
  neutral: 'text-muted-foreground',
};

/**
 * How a mode reads, from what its runtime declared about it.
 *
 * The autonomy stop wins over divergence, because a person standing at the top
 * of the dial is not being told their runtime bends a promise — they are at the
 * stop where there was no asking promise to bend.
 *
 * A mode with no descriptor — capabilities still arriving, or one the runtime no
 * longer declares — is neutral. No data, no claim.
 *
 * ## The predicate split, and when it has to be reconciled
 *
 * This reads {@link isAutonomyStop} — where a mode SITS on the dial. The mark on
 * a session row asks a different question: `useSessionPermissionSummary`'s
 * `isFullPower`, which is `isBypassSemantics` (never asks AND reaches everything).
 * `permission-semantics` keeps the two apart on purpose, and no shipped runtime
 * makes them disagree, because every declared autonomy stop also reaches
 * everything.
 *
 * A runtime declaring a SANDBOXED autonomy stop is what would break the tie: the
 * dial and the status strip would read green while the session's row carried no
 * mark at all. Reconcile them then — one predicate serving both — rather than
 * adding a third answer here.
 *
 * @param descriptor - The mode as its runtime declared it, if resolved.
 */
export function trustTone(descriptor: PermissionModeDescriptor | undefined): TrustTone {
  if (!descriptor) return 'neutral';
  if (isAutonomyStop(descriptor)) return 'power';
  if (isDivergent(descriptor)) return 'divergent';
  return 'neutral';
}

/**
 * The colour a mode paints on a surface that already has one — the status
 * strip's word, which inherits the line's muted tint and its own hover rule.
 *
 * Only full power is painted. Divergence is deliberately silent here: the strip
 * is one word wide, the caption inside the popover carries the amber and the
 * sentence explaining it, and a second amber with no room for the reason is an
 * alarm nobody can act on (spec `trust-dial`, decision 3A).
 *
 * @param descriptor - The mode as its runtime declared it, if resolved.
 */
export function trustToneAccent(descriptor: PermissionModeDescriptor | undefined): string {
  return trustTone(descriptor) === 'power' ? TRUST_TONE_TEXT.power : '';
}

/**
 * The colour a mode paints on a surface that owns its whole colour — the dial's
 * caption, where muted is a real answer rather than an absence.
 *
 * @param descriptor - The mode as its runtime declared it, if resolved.
 */
export function trustToneText(descriptor: PermissionModeDescriptor | undefined): string {
  return TRUST_TONE_TEXT[trustTone(descriptor)];
}
