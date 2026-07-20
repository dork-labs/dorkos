import { CalendarClock, FolderOpen, Puzzle, Wrench } from 'lucide-react';
import { Button, ResponsiveDialogTitle, ResponsiveDialogDescription } from '@/layers/shared/ui';
import { isSingleEmoji } from '@/layers/shared/lib';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import type { CreationSeed } from '@/layers/shared/model';

/** Props for {@link ArrivalConfirm} — the M1 arrival confirm (one agent, no fork). */
export interface ArrivalConfirmProps {
  /** The agent taking shape, with everything the offer already knows about it. */
  seed: CreationSeed;
  /** Where the agent will live once created (`defaultDirectory/slug`). */
  resolvedDirectory: string;
  /**
   * True when the derived name is ready to create with. On this step it can
   * only be false when the offer arrived without a usable name (conflict checks
   * don't run here, and slugify always yields a valid slug from a non-blank
   * name) — the create button disables and a hint points at "Customize first".
   */
  canSubmit: boolean;
  /** True while the create request is in flight — disables the primary action. */
  isCreating: boolean;
  /** Create the agent as offered, in one click. */
  onCreate: () => void;
  /** Open the naming step first, pre-filled from the offer. */
  onCustomize: () => void;
  /** Dismiss — the offer stays recoverable from where it came from. */
  onNotNow: () => void;
}

/**
 * The arrival confirm (M1): a single centered card that introduces one
 * ready-made agent and lets the person bring it to life in a click — no
 * gallery, no method fork. Shown when the creation dialog is opened from a
 * specific offer (a Shape's agent today).
 *
 * The ledger is honest: it names what turns on and where the agent lives,
 * lists its capabilities, lists skills without claiming they are installed, and
 * shows a schedule line only when the offer actually declares a cadence.
 *
 * @param props - The seed to introduce plus the arrival actions.
 */
export function ArrivalConfirm({
  seed,
  resolvedDirectory,
  canSubmit,
  isCreating,
  onCreate,
  onCustomize,
  onNotNow,
}: ArrivalConfirmProps) {
  const { displayName, persona, runtime, capabilities, skills, schedule, icon } = seed.template;
  const runtimeLabel = getRuntimeDescriptor(runtime ?? 'claude-code').label;
  const initial = displayName.trim().charAt(0).toUpperCase() || '?';
  // Show the seeded emoji face (the same one M3's picker and AgentPreviewCard
  // use) when the offer carries a real emoji; fall back to the name's initial.
  const face = icon && isSingleEmoji(icon) ? icon : initial;
  const sourceLine = seed.sourceLabel
    ? `Offered by ${seed.sourceLabel}.`
    : 'A ready-made agent, ready when you are.';

  return (
    <div className="mx-auto max-w-md space-y-6" data-testid="arrival-confirm">
      {/* Face + name */}
      <div className="flex flex-col items-center gap-3 text-center">
        <span
          className="bg-primary/10 text-primary flex size-20 items-center justify-center rounded-full text-4xl font-semibold"
          aria-hidden="true"
        >
          {face}
        </span>
        <div className="space-y-1">
          <ResponsiveDialogTitle className="text-xl">Meet {displayName}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>{sourceLine}</ResponsiveDialogDescription>
        </div>
      </div>

      {/* The job, in the agent's own voice */}
      {persona && (
        <p className="text-foreground text-sm leading-relaxed whitespace-pre-line">{persona}</p>
      )}

      {/* Honest ledger — what turns on, where it lives, only what's true */}
      <dl className="bg-muted/30 space-y-2.5 rounded-lg border p-3.5 text-sm">
        <div className="flex items-center gap-2">
          <RuntimeGlyph runtime={runtime} />
          <dt className="text-muted-foreground shrink-0">Runs on</dt>
          <dd>{runtimeLabel}</dd>
        </div>
        <div className="flex items-start gap-2">
          <FolderOpen className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <dt className="text-muted-foreground shrink-0">Lives in</dt>
          <dd className="min-w-0">
            <code className="text-xs break-all">{resolvedDirectory}</code>
          </dd>
        </div>
        {schedule && (
          <div className="flex items-start gap-2" data-testid="arrival-schedule">
            <CalendarClock className="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <dt className="text-muted-foreground shrink-0">Runs on a schedule</dt>
            <dd>{schedule}</dd>
          </div>
        )}
        {capabilities && capabilities.length > 0 && (
          <div className="flex items-start gap-2">
            <Wrench className="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <dt className="text-muted-foreground shrink-0">Can</dt>
            <dd>{capabilities.join(', ')}</dd>
          </div>
        )}
        {skills && skills.length > 0 && (
          <div className="flex items-start gap-2">
            <Puzzle className="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <dt className="text-muted-foreground shrink-0">Uses skills</dt>
            <dd>{skills.join(', ')}</dd>
          </div>
        )}
      </dl>

      {/* Actions */}
      <div className="flex flex-col gap-2">
        {!canSubmit && (
          <p className="text-warning text-center text-xs" data-testid="arrival-needs-name">
            This agent still needs a name — choose &ldquo;Customize first&rdquo; to give it one.
          </p>
        )}
        <Button
          size="lg"
          onClick={onCreate}
          disabled={isCreating || !canSubmit}
          data-testid="arrival-create"
        >
          {isCreating ? 'Creating…' : `Create ${displayName}`}
        </Button>
        <div className="flex items-center justify-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCustomize}
            className="text-muted-foreground"
            data-testid="arrival-customize"
          >
            Customize first
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onNotNow}
            className="text-muted-foreground"
            data-testid="arrival-not-now"
          >
            Not now
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The runtime's own icon, falling back to nothing surprising. */
function RuntimeGlyph({ runtime }: { runtime?: CreationSeed['template']['runtime'] }) {
  const Icon = getRuntimeDescriptor(runtime ?? 'claude-code').icon;
  return <Icon size={16} className="text-muted-foreground shrink-0" />;
}
