import { useId } from 'react';
import { ClipboardList, Shield, Sparkles, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PermissionModeDescriptor, PermissionStop } from '@dorkos/shared/agent-runtime';
import {
  cn,
  isDivergent,
  isWorkingMode,
  permissionModeLabel,
  resolveTrustStops,
  type TrustStop,
} from '@/layers/shared/lib';
import { SegmentedControl, SegmentedControlItem, Switch } from '@/layers/shared/ui';

/**
 * The three stops, in the person's words. Fixed across every runtime on purpose
 * (spec `trust-dial`, decision 2A): the words are the question — *when should
 * this agent ask me?* — and a vocabulary that changed per runtime would make the
 * answer unlearnable. Where a runtime cannot keep a stop's promise, the caption
 * says so; the word does not bend.
 */
const STOP_LABELS: Record<PermissionStop, string> = {
  ask: 'Ask first',
  act: 'Act',
  autonomy: 'Full autonomy',
};

/**
 * One icon per stop, not per mode. The old table gave every mode id its own
 * glyph, which meant a runtime's unfamiliar mode name drew a shield and a
 * familiar one drew a lock, saying nothing. Three positions, three shapes.
 */
const STOP_ICONS: Record<PermissionStop, LucideIcon> = {
  ask: Shield,
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
 * — gets the shield, the resting shape, rather than nothing.
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
 *   workspace-write is the case the whole design exists for.
 * - **The current state is always visible.** A session sitting at a mode with no
 *   stop (one the runtime dropped, or one this model cannot run) shows no
 *   selection AND a line naming the mode, because a dial with nothing lit and no
 *   explanation is how the old picker lost people.
 *
 * @param props - The current mode, the runtime's declared modes, and the change
 *   handler.
 */
export function TrustDial({ mode, descriptors, onChangeMode, planActive }: TrustDialProps) {
  const captionId = useId();
  const stops = resolveTrustStops(descriptors);
  const current = descriptors.find((d) => d.id === mode);
  const selected = stops.find(
    (s) => s.mode.id === mode || s.refinements.some((r) => r.id === mode)
  );
  // A mode the dial cannot place: dropped by the runtime, or filtered out for
  // this model. `plan` is not stranded — it is declared, it is just not a stop.
  const stranded = current === undefined && stops.length > 0;

  return (
    <div className="flex flex-col gap-2">
      {stops.length > 0 && (
        <SegmentedControl
          aria-label="How much this agent may do without asking"
          aria-describedby={captionId}
          value={selected?.stop ?? ''}
          disabled={planActive}
          onValueChange={(stop) => {
            const next = stops.find((s) => s.stop === stop);
            if (next) onChangeMode(next.mode.id);
          }}
        >
          {stops.map(({ stop }) => {
            const Icon = STOP_ICONS[stop];
            return (
              <SegmentedControlItem key={stop} value={stop} aria-label={STOP_LABELS[stop]}>
                <Icon className="size-(--size-icon-xs) shrink-0" aria-hidden />
                <span className="truncate">{STOP_LABELS[stop]}</span>
              </SegmentedControlItem>
            );
          })}
        </SegmentedControl>
      )}

      <p
        id={captionId}
        data-testid="trust-dial-caption"
        className={cn(
          'px-1 text-xs leading-relaxed',
          current && isDivergent(current)
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-muted-foreground'
        )}
      >
        {current?.promise}
        {planActive && (
          <span className="text-muted-foreground"> Turn off Plan to change this.</span>
        )}
      </p>

      {stranded && (
        <p
          role="status"
          data-testid="trust-dial-stranded"
          className="text-muted-foreground px-1 text-xs leading-relaxed"
        >
          This session is set to “{permissionModeLabel(mode)}”, which is not one of these. Pick a
          stop to change it.
        </p>
      )}

      {selected?.refinements.map((refinement) => (
        <RefinementRow
          key={refinement.id}
          refinement={refinement}
          stop={selected}
          mode={mode}
          onChangeMode={onChangeMode}
          disabled={planActive}
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
        <span className="bg-muted text-muted-foreground rounded px-1 py-px text-[10px] font-medium tracking-wide uppercase">
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
