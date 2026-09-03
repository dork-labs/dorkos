import { AlertTriangle, CalendarClock, FolderOpen, Puzzle, Wrench } from 'lucide-react';
import type { PreviewSchedule } from '@dorkos/shared/marketplace-schemas';
import {
  Button,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  Skeleton,
} from '@/layers/shared/ui';
import { isSingleEmoji } from '@/layers/shared/lib';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { describePreviewSchedule } from '@/layers/entities/marketplace';
import type { CreationSeed } from '@/layers/shared/model';

/** Props for {@link ArrivalConfirm} — the M1 arrival confirm (one agent, no fork). */
export interface ArrivalConfirmProps {
  /** The agent taking shape, with everything the offer already knows about it. */
  seed: CreationSeed;
  /**
   * Every scheduled job the offer's package ships, each already carrying the
   * permission mode it will really get. Empty for an offer that schedules
   * nothing, and for a Shape offer, whose cadence arrives as
   * `seed.template.schedule` instead.
   */
  packageSchedules: PreviewSchedule[];
  /**
   * True while DorkOS is still asking what the package runs on its own. The
   * create action waits for the answer — an agent package gets no install
   * confirmation dialog, so this card is the only place the person is told, and
   * a card that lets you say yes before it knows is the silence DOR-644 is
   * about.
   */
  isCheckingOffer: boolean;
  /**
   * True when that question could not be answered. Said out loud rather than
   * swallowed: "we could not check" must never render the same as "there is
   * nothing to check". It does not block — the schedule still cannot arm itself
   * without a separate approval once the agent exists.
   */
  offerCheckFailed: boolean;
  /**
   * Where the agent will live once created (`defaultDirectory/slug`), using the
   * absolute directory the server reports. Empty until the config arrives — the
   * "Lives in" row shows a skeleton rather than a blank for that moment.
   */
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
 * That last part is why `packageSchedules` exists. A marketplace agent package
 * can ship a scheduled job inside its own files, which no browse listing can
 * see — and because `useRequestInstall` sends agent packages here instead of to
 * the install confirmation dialog, this card is the only chance a person gets to
 * read it before saying yes (DOR-644).
 *
 * @param props - The seed to introduce plus the arrival actions.
 */
export function ArrivalConfirm({
  seed,
  packageSchedules,
  isCheckingOffer,
  offerCheckFailed,
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
            {/* Only the server knows the real directory, so for one moment on a
                cold load there is no honest answer. A skeleton says "still
                coming"; an empty line under this label reads as broken. */}
            {resolvedDirectory ? (
              <code className="text-xs break-all">{resolvedDirectory}</code>
            ) : (
              <Skeleton className="h-3.5 w-48 max-w-full rounded" />
            )}
          </dd>
        </div>
        {schedule && (
          <div className="flex items-start gap-2" data-testid="arrival-schedule">
            <CalendarClock className="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <dt className="text-muted-foreground shrink-0">Runs on a schedule</dt>
            <dd>{schedule}</dd>
          </div>
        )}
        {/* What the package itself schedules, in the same words the install
            dialog uses for every other package type — including the permission
            mode, which is the fact that decides how much an unattended job may
            do. The modes here are already clamped server-side, so this says what
            the job GETS rather than what its author asked for. */}
        {packageSchedules.length > 0 && (
          <div className="flex items-start gap-2" data-testid="arrival-package-schedules">
            <CalendarClock className="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <dt className="text-muted-foreground shrink-0">Brings a schedule</dt>
            <dd className="min-w-0 space-y-1">
              {packageSchedules.map((job, index) => (
                <p key={`${job.name}-${index}`}>
                  <span className="font-medium">{job.name}</span> — {describePreviewSchedule(job)}
                </p>
              ))}
            </dd>
          </div>
        )}
        {offerCheckFailed && (
          <div className="flex items-start gap-2" data-testid="arrival-offer-check-failed">
            <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" />
            <dt className="text-muted-foreground shrink-0">Not checked</dt>
            <dd className="min-w-0">
              DorkOS could not find out whether this agent brings work on a timer. Anything it does
              bring still has to be approved before it runs.
            </dd>
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
        {isCheckingOffer && (
          <p
            className="text-muted-foreground text-center text-xs"
            data-testid="arrival-checking-offer"
          >
            Checking what this agent runs on its own…
          </p>
        )}
        <Button
          size="lg"
          onClick={onCreate}
          disabled={isCreating || !canSubmit || isCheckingOffer}
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
