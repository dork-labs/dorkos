/**
 * The Trust Dial — the one control every surface uses to answer *when should
 * this agent ask me?*
 *
 * ## Why it lives in `shared/ui`
 *
 * A dial that only the chat status line could render is how the product ended up
 * with three different permission pickers telling three different stories. This
 * one is purely presentational — descriptors in, a mode id out — with no session,
 * no binding, no task and no query anywhere in it, so a session popover, a relay
 * binding dialog (`entities/`) and the task form (`features/`) can all render the
 * same control without any of them importing another's layer. Its neighbours here
 * are the two pieces it is made of: `segmented-control` and
 * `permission-mode-scope-note`.
 *
 * The wiring — which runtime's profile, what a change costs, whether it needs
 * confirming — stays with each caller, because that part genuinely differs.
 *
 * @module shared/ui/trust-dial
 */
import { useId, type ReactNode } from 'react';
import { ClipboardList, Lock, Shield, Sparkles, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PermissionModeDescriptor, PermissionStop } from '@dorkos/shared/agent-runtime';
import {
  cn,
  isWorkingMode,
  permissionModeLabel,
  resolveTrustStops,
  type TrustStop,
} from '@/layers/shared/lib';
import { SegmentedControl, SegmentedControlItem } from './segmented-control';
import { Switch } from './switch';
import { trustToneText } from './trust-tone';

/**
 * The three stops, in the person's words. Fixed across every runtime on purpose
 * (spec `trust-dial`, decision 2A): the words are the question — *when should
 * this agent ask me?* — and a vocabulary that changed per runtime would make the
 * answer unlearnable. Where a runtime cannot keep a stop's promise, the caption
 * says so; the word does not bend.
 *
 * A SURFACE may still read in its own voice ({@link TrustDialProps.stopLabels}),
 * which is a different thing from bending per runtime: Settings words all three
 * stops as behaviour rather than commands, on every dial it draws.
 */
const STOP_LABELS: Record<PermissionStop, string> = {
  ask: 'Ask first',
  act: 'Act',
  autonomy: 'Full autonomy',
};

/**
 * What a dial position is called, for the surfaces that name one outside the
 * dial — Settings' caption, and the in-session offer to make a stop the default.
 *
 * Exported from here rather than restated there, because two spellings of "Full
 * autonomy" on two screens is how a fixed vocabulary stops being one.
 *
 * @param stop - A dial position.
 */
export function stopLabel(stop: PermissionStop): string {
  return STOP_LABELS[stop];
}

/**
 * The three stops as descriptors, for the ONE dial that belongs to no runtime:
 * Settings' "New sessions start in", which sets a runtime-neutral stop that
 * every runtime then resolves through its own profile (spec `trust-dial`,
 * decision 6).
 *
 * The `id`s are the stop names, and that is the point — this dial's value IS the
 * stop, so a caller reads `id` as one. Every other dial in the product is
 * rendered from a runtime's declared modes and must stay that way; this one has
 * no runtime to ask, and the honest thing at that moment is the canonical
 * promise with the per-runtime consequences spelled out beneath it.
 *
 * The `promise` sentences are the stops' canonical meaning — what a person is
 * entitled to expect from the position they picked, before any runtime speaks
 * ({@link stopExpectation} is the same claim in machine form). `reach` on the
 * autonomy stop is `'everything'` because that is what the stop canonically
 * means, not because any colour hangs off it: the caption's green comes from the
 * stop itself ({@link trustToneText}).
 */
export const CANONICAL_TRUST_STOPS: readonly PermissionModeDescriptor[] = [
  {
    id: 'ask',
    label: STOP_LABELS.ask,
    stop: 'ask',
    asks: 'always',
    reach: 'edit',
    promise: 'Asks before it changes anything.',
  },
  {
    id: 'act',
    label: STOP_LABELS.act,
    stop: 'act',
    asks: 'when-risky',
    reach: 'edit',
    promise: 'Gets on with the work and stops for the risky parts.',
  },
  {
    id: 'autonomy',
    label: STOP_LABELS.autonomy,
    stop: 'autonomy',
    asks: 'never',
    reach: 'everything',
    promise: 'Acts without stopping for approval — still asks when it matters.',
  },
];

/**
 * One icon per stop, not per mode. The old table gave every mode id its own
 * glyph, which meant a runtime's unfamiliar mode name drew a shield and a
 * familiar one drew a lock, saying nothing. Three positions, three shapes.
 *
 * The padlock on "Ask first" is the whole of that stop's marking, and it is
 * deliberately a shape rather than a colour. Asking first is limited — the agent
 * cannot get on with the work until somebody answers — and the padlock says so
 * in the same mental model the rest of the product uses for a capability that is
 * held back. Painting the safe resting state in the alarm colour would say
 * something else entirely: that the cautious choice is a mistake.
 */
const STOP_ICONS: Record<PermissionStop, LucideIcon> = {
  ask: Lock,
  act: Sparkles,
  autonomy: Zap,
};

/**
 * The shape that stands for a mode wherever it is drawn small — the status line's
 * word, a session row's glyph.
 *
 * A way of working gets the clipboard, because it is not a point on the trust
 * axis and drawing it as one would be a lie in one glyph. A mode with no
 * descriptor in hand — capabilities still loading, or a mode the runtime dropped
 * — gets the shield, which belongs to no stop: it is the shape for "we do not
 * know yet", and it says nothing about how much this agent may do.
 *
 * @param props - The mode as its runtime declared it (if resolved), and classes.
 */
export function TrustModeIcon({
  descriptor,
  className,
}: {
  descriptor: PermissionModeDescriptor | undefined;
  className?: string;
}) {
  const Icon: LucideIcon = !descriptor
    ? Shield
    : isWorkingMode(descriptor)
      ? ClipboardList
      : STOP_ICONS[descriptor.stop];
  return <Icon className={className} aria-hidden />;
}

/**
 * Research-preview marks, keyed by mode id.
 *
 * The last id-keyed table in this feature, and it stays until a descriptor field
 * carries the fact: "this is a preview" is a promise about the mode's maturity,
 * not about what it does, so none of the semantics fields answer it. An id
 * nobody listed simply gets no badge.
 */
const MODE_TAGS: Record<string, string> = {
  auto: 'Preview',
};

export interface TrustDialProps {
  /** The session's permission mode — a runtime mode id, not a stop. */
  mode: string;
  /**
   * Every mode the runtime declares, in declared order. Already filtered of
   * anything this session cannot use (a refinement the model cannot run), so a
   * mode missing here is a mode the dial must not offer.
   */
  descriptors: readonly PermissionModeDescriptor[];
  /** Apply a mode change. Receives a runtime mode id. */
  onChangeMode: (mode: string) => void;
  /** True while a way of working (Plan) holds the session, freezing the stops. */
  planActive?: boolean;
  /**
   * Freeze the stops for a reason that is not the session's mode — a surface
   * whose write has nowhere to go yet, typically because the runtime has not
   * finished declaring itself.
   *
   * Distinct from {@link TrustDialProps.planActive}, which freezes AND says why
   * in the caption ("Turn off Plan to change this"). This one adds no sentence,
   * because the reason belongs to the caller's screen and lasts a round-trip.
   */
  disabled?: boolean;
  /**
   * What to say when the current mode is not one of the stops — replacing the
   * default sentence, which is written for a live session where picking a stop
   * takes effect at once.
   *
   * A form is the other case: a binding or a task saved at a mode the dial does
   * not offer keeps that mode until somebody picks a stop, and *saving* is what
   * decides. Those callers say so in their own words rather than coercing the
   * stored mode into one of the stops, which is the bug this replaces (DOR-496).
   */
  strandedNote?: ReactNode;
  /**
   * Treat a way of working (Plan) as a mode the dial cannot place, instead of
   * freezing the stops behind it.
   *
   * The freeze exists because a session has a Plan switch *somewhere else* that
   * owns the mode, so the dial points at it and waits. A form has no such switch:
   * a binding or a task saved at `plan` would freeze on a control nobody can
   * unfreeze, and the person could not change the setting at all. On those
   * surfaces a stored way of working is exactly like any other mode with no stop
   * — kept as it is, named, and replaced only when somebody picks a stop.
   *
   * Defaults to false, which is the session behaviour.
   */
  strandsWorkingMode?: boolean;
  /**
   * Offer a quiet way to leave the ask stop, for a surface that has somewhere to
   * send them — the Control Center, or the full-power door.
   *
   * When the dial is resting at the ask stop and this is supplied, a neutral
   * "Limited — unlock" affordance appears beneath the caption. It is a shape and
   * a pointer, never an alarm: asking first is a limited posture (the agent
   * cannot get on until somebody answers), and the padlock says so in the same
   * mental model the rest of the product uses — painting the cautious choice red
   * would shame it (design `full-power-defaults` §6). Omitted on surfaces with no
   * unlock destination — a task or binding form, where the choice is saved, not
   * unlocked — so nothing appears there.
   */
  onUnlock?: () => void;
  /**
   * Re-word one or more stops for a surface that reads in a different voice.
   *
   * The vocabulary is still fixed per surface, which is what decision 2A is
   * actually about: a stop must not be renamed per RUNTIME, or the answer stops
   * being learnable. Settings is the one place that reads cold — months later,
   * by somebody who did not set it — so its dials say "Pauses at big steps"
   * where a live session says "Act", and the global row above them has always
   * said exactly that. Two spellings on one screen was the drift; this closes
   * it.
   *
   * Anything not supplied keeps the default word.
   */
  stopLabels?: Partial<Record<PermissionStop, string>>;
}

/**
 * How much this agent may do without asking, as one control with three stops.
 *
 * Everything on screen is derived from what the runtime declared — the stops it
 * can take, the sentence under them, whether that sentence needs a warning. No
 * mode ids, no runtime names (spec `trust-dial`, decisions 1 and 2A). Three
 * consequences worth knowing before changing this:
 *
 * - **A stop a runtime has no mode for is absent.** Not greyed out: a disabled
 *   position is an invitation to click and find out why, and the answer would be
 *   "this agent cannot do that", which the missing stop already says.
 * - **The caption is the runtime's own sentence**, rendered verbatim. It turns
 *   amber when the runtime asks less often than the stop promised — Codex's
 *   workspace-write is the case the whole design exists for — and green at the
 *   top stop, because full power is what this product is for and the moment of
 *   choosing it should not read like a mistake ({@link trustToneText}).
 * - **The current state is always visible.** A session sitting at a mode with no
 *   stop (one the runtime dropped, or one this model cannot run) shows no
 *   selection AND a line naming the mode, because a dial with nothing lit and no
 *   explanation is how the old picker lost people.
 *
 * @param props - The current mode, the runtime's declared modes, and the change
 *   handler.
 */
export function TrustDial({
  mode,
  descriptors,
  onChangeMode,
  planActive,
  disabled,
  strandedNote,
  strandsWorkingMode,
  stopLabels,
  onUnlock,
}: TrustDialProps) {
  const captionId = useId();
  /** This dial's word for each stop: the caller's where it has one, ours otherwise. */
  const labelFor = (stop: PermissionStop) => stopLabels?.[stop] ?? STOP_LABELS[stop];
  const stops = resolveTrustStops(descriptors);
  const current = descriptors.find((d) => d.id === mode);
  const selected = stops.find(
    (s) => s.mode.id === mode || s.refinements.some((r) => r.id === mode)
  );
  // A way of working holds the session — Plan, or whatever a future runtime calls
  // its own. Read from the descriptor as well as the prop: conformance forbids a
  // runtime whose only ask-stop mode is a way of working, but a dial that shows
  // nothing lit and no reason is the failure this component exists to end, so it
  // does not depend on the caller passing the flag.
  const working = current !== undefined && isWorkingMode(current);
  const frozen = planActive === true || (working && strandsWorkingMode !== true);
  // What the controls actually obey. Kept apart from `frozen` on purpose: the
  // caption's "Turn off Plan to change this" explains a MODE holding the dial,
  // and a caller's own freeze has no such sentence to offer.
  const locked = frozen || disabled === true;
  // A mode the dial cannot place: dropped by the runtime, or filtered out for
  // this model. In a session a way of working is not stranded — it is declared,
  // it is just not a stop, and the switch that owns it is one strip away. On a
  // surface with no such switch it is stranded like anything else, or the dial
  // freezes on a control nobody can unfreeze (`strandsWorkingMode`).
  const unplaceable = current === undefined || (working && strandsWorkingMode === true);
  const stranded = unplaceable && stops.length > 0;

  return (
    <div className="flex flex-col gap-2">
      {stops.length > 0 && (
        <SegmentedControl
          aria-label="How much this agent may do before it checks with you"
          aria-describedby={captionId}
          value={selected?.stop ?? ''}
          disabled={locked}
          onValueChange={(stop) => {
            const next = stops.find((s) => s.stop === stop);
            if (next) onChangeMode(next.mode.id);
          }}
        >
          {stops.map(({ stop }) => {
            const Icon = STOP_ICONS[stop];
            return (
              <SegmentedControlItem key={stop} value={stop} aria-label={labelFor(stop)}>
                <Icon className="size-(--size-icon-xs) shrink-0" aria-hidden />
                <span className="truncate">{labelFor(stop)}</span>
              </SegmentedControlItem>
            );
          })}
        </SegmentedControl>
      )}

      <p
        id={captionId}
        data-testid="trust-dial-caption"
        className={cn('px-1 text-xs leading-relaxed', trustToneText(current))}
      >
        {current?.promise}
        {frozen && current && (
          <span className="text-muted-foreground"> Turn off {current.label} to change this.</span>
        )}
      </p>

      {/* The ask stop is limited — the agent waits for an answer before it can
          get on — and this says so with a padlock and a quiet way out, never a
          colour. Only where the caller has an unlock destination to point at. */}
      {selected?.stop === 'ask' && onUnlock && !locked && (
        <button
          type="button"
          data-testid="trust-dial-limited-unlock"
          onClick={onUnlock}
          aria-label="Unlock full power in the Control Center"
          className="focus-ring text-muted-foreground hover:text-foreground -mx-0.5 flex w-fit items-center gap-1.5 rounded-sm px-1 text-xs leading-relaxed transition-colors"
        >
          <Lock className="size-3 shrink-0" aria-hidden />
          <span>
            Limited — <span className="underline underline-offset-2">unlock</span>
          </span>
        </button>
      )}

      {stranded && (
        <p
          role="status"
          data-testid="trust-dial-stranded"
          className="text-muted-foreground px-1 text-xs leading-relaxed"
        >
          {strandedNote ?? (
            <>
              {/* The runtime's own word for the mode wherever it declared one —
                  a stranded WAY OF WORKING has a descriptor in hand, and the id
                  table is only ever the answer for a mode nobody declared. */}
              This session is set to “{current?.label ?? permissionModeLabel(mode)}”, which is not
              one of these. Pick a stop to change it.
            </>
          )}
        </p>
      )}

      {selected?.refinements.map((refinement) => (
        <RefinementRow
          key={refinement.id}
          refinement={refinement}
          stop={selected}
          mode={mode}
          onChangeMode={onChangeMode}
          disabled={locked}
        />
      ))}
    </div>
  );
}

/**
 * A setting that lives inside a stop rather than beside it — Claude's `auto`,
 * which changes how the agent decides without changing how far it may go.
 *
 * Switching it off returns to the stop's own mode, so the person can never end
 * up somewhere they did not choose by turning something off.
 *
 * @internal
 */
function RefinementRow({
  refinement,
  stop,
  mode,
  onChangeMode,
  disabled,
}: {
  refinement: PermissionModeDescriptor;
  stop: TrustStop;
  mode: string;
  onChangeMode: (mode: string) => void;
  disabled?: boolean;
}) {
  const tag = MODE_TAGS[refinement.id];
  return (
    <label className="flex cursor-pointer items-center gap-2 px-1 text-xs">
      <Sparkles className="text-muted-foreground size-(--size-icon-xs) shrink-0" aria-hidden />
      <span className="text-foreground truncate">{refinement.label}</span>
      {tag && (
        <span className="bg-muted text-muted-foreground rounded px-1 py-px text-3xs font-medium tracking-wide uppercase">
          {tag}
        </span>
      )}
      <span className="min-w-0 flex-1" />
      <Switch
        size="sm"
        checked={mode === refinement.id}
        disabled={disabled}
        aria-label={refinement.label}
        onCheckedChange={(on) => onChangeMode(on ? refinement.id : stop.mode.id)}
      />
    </label>
  );
}
