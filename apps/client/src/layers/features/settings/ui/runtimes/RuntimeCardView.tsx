/**
 * One runtime's settings card, as a component that knows nothing.
 *
 * Every setting that belongs to a runtime lives on that runtime's card — model,
 * effort, where it stops, whatever the runtime itself declares, and the choice of
 * which runtime new conversations start on (design §1). This file is the whole
 * of that card's appearance and none of its behaviour: no config read, no config
 * write, no query, no capability lookup. Its container hands it values and takes
 * back events, which is what lets the dev playground render every state the
 * design session drew — collapsed, expanded, ready, connecting, default,
 * default-but-broken, model-gone, effort-ignored — without a server (design §7).
 *
 * The three honesty rules the card is built around, all from design §5:
 *
 * - **A not-ready card says one true sentence** rather than a summary of what a
 *   disconnected runtime "will do".
 * - **A broken default keeps its pill.** The warning and the setting share a
 *   card, because hiding either one hides the problem.
 * - **Absences are said, not skipped.** A declared section with no renderer
 *   leaves no empty box; a card with nothing to open offers no way to open it.
 *
 * @module features/settings/ui/runtimes/RuntimeCardView
 */
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import type { RuntimeSettingsSection } from '@dorkos/shared/agent-runtime';
import { cn } from '@/layers/shared/lib';
import { CollapsibleFieldCard } from '@/layers/shared/ui';
import { getRuntimeDescriptor, type ExpiringSignIn } from '@/layers/entities/runtime';
import {
  RECONNECT_TRIGGERS,
  RuntimeCardHeader,
  type RuntimeCardReconnect,
} from './RuntimeCardHeader';
import type { RuntimeSummarySegment } from './RuntimeCardSummary';
import { ModelRow, type ModelRowProps } from './rows/ModelRow';
import { EffortRow, type EffortRowProps } from './rows/EffortRow';
import { TrustRow, type TrustRowProps } from './rows/TrustRow';

export type { RuntimeCardReconnect } from './RuntimeCardHeader';

/** What a card says instead of a summary when the runtime cannot be used yet. */
const LOCKED_LINE = 'One sign-in away. Settings unlock once it’s connected.';

/** What a card says when the runtime new conversations start on cannot start one. */
const BROKEN_DEFAULT_LINE =
  'Your default runtime isn’t connected. New conversations can’t start here.';

/**
 * What a card says while a working sign-in is running out of time.
 *
 * Said early and in the present tense, because the whole point is to be read
 * BEFORE anything breaks: the sign-in still works, and this is the window in
 * which fixing it costs nothing.
 *
 * @param label - The runtime's name, as a person calls it.
 * @param timeLeft - How long is left, already in words (e.g. `'2 days'`).
 */
const expiringSignInLine = (label: string, timeLeft: string) =>
  `Your ${label} sign-in runs out in ${timeLeft}. Sign in again before your agents stall.`;

/**
 * What a card says in the last stretch: the sign-in cannot renew itself any
 * more, but the session in hand still works, so this is the final chance to fix
 * it on purpose rather than mid-turn. Said in the present tense because the card
 * still reads Ready and, for a little while longer, honestly so.
 *
 * @param label - The runtime's name, as a person calls it.
 */
const lapsedSignInLine = (label: string) =>
  `Your ${label} sign-in is out of time and will stop working shortly. Sign in again to avoid an interruption.`;

/**
 * What a card says instead of rows when the runtime has nowhere to keep them.
 *
 * @param label - The runtime's name, as a person calls it.
 */
const noSettingsLine = (label: string) =>
  `${label} keeps no settings of its own. It uses its own model and follows the shared setting below.`;

/**
 * The words that turn the summary's chips into a sentence (design §4).
 *
 * View chrome, not a segment: `buildRuntimeCardSummary` stays a pure list of
 * facts, and the lead-in is how this view reads them out.
 */
const SUMMARY_LEAD_IN = 'Starts with';

/**
 * The card's own identity is `type`; the rows are told theirs, so each row's
 * props arrive without the two fields the card already knows.
 */
type RowProps<T> = Omit<T, 'runtimeType' | 'runtimeLabel'>;

/** Everything the card is told, and every event it reports. */
export interface RuntimeCardViewProps {
  /** Runtime type id, e.g. `'claude-code'`. Names the card and scopes its test ids. */
  type: string;
  /** One line of identity beneath the name. */
  subtitle?: string | undefined;
  /** Whether the runtime can start a conversation right now. */
  ready: boolean;
  /** Whether new conversations start on this runtime. */
  isDefault: boolean;
  /**
   * The runtime's sign-in deadline, when it is close enough to be worth saying
   * so. Omit — as it is nearly always — to show nothing: most credentials report
   * no deadline at all, and silence is the honest reading of an unknown one.
   */
  expiringSignIn?: ExpiringSignIn | undefined;
  /**
   * Make this runtime the default. Omit to render no such affordance — a card
   * that already is the default, or a surface where the choice is not offered.
   */
  onMakeDefault?: (() => void) | undefined;
  /**
   * Whether the body is open. Controlled from outside so cards expand
   * independently (no accordion auto-close, design §4) and so a showcase can
   * render an open card directly.
   */
  expanded: boolean;
  /** Open or close the body. */
  onToggleExpanded: () => void;
  /**
   * The collapsed line's segments, from `buildRuntimeCardSummary`. Empty renders
   * nothing at all on a ready card, and the not-ready sentence on one that is
   * not — never an empty line.
   */
  summary: readonly RuntimeSummarySegment[];
  /** The connect flow for a not-ready runtime, supplied by the container. */
  connectSlot?: ReactNode;
  /** The quiet ready-state affordance that reopens a connected runtime's flow. */
  reconnect?: RuntimeCardReconnect | undefined;
  /** The reopened flow itself, rendered under the header while it is open. */
  reconnectPanel?: ReactNode;
  /** The Model row's props, minus the identity the card already carries. */
  model: RowProps<ModelRowProps>;
  /** The Effort row's props, minus the identity the card already carries. */
  effort: RowProps<EffortRowProps>;
  /** The trust row's props, minus the identity the card already carries. */
  trust: RowProps<TrustRowProps>;
  /**
   * Whether this runtime has anywhere to keep the three standing rows — model,
   * effort, and where it stops. It does when it declares a `configSection`, and
   * a runtime that declares none (`test-mode` is the real one) has nowhere:
   * every one of those writes would fall on the floor. So the card says that in
   * one line rather than drawing three controls that look live and are not
   * (design §5: absences are said, not skipped).
   *
   * Default `true`, which is also what a card renders while the capability map
   * is still loading: a declaration that has not arrived yet is not evidence
   * against, exactly as it is not for `effort.supportsEffort`.
   */
  storesDefaults?: boolean | undefined;
  /** The sections this runtime declares, in declared order. */
  sections?: readonly RuntimeSettingsSection[] | undefined;
  /**
   * Render one declared section. A kind this client has no renderer for returns
   * nothing and takes up no space — the forward-compatible rule that lets a
   * runtime declare a section this build has never heard of.
   */
  renderSection?: ((kind: string) => ReactNode) | undefined;
  /** Contents of the Setup details disclosure. Omit and the disclosure is absent. */
  setupDetails?: ReactNode;
  /**
   * What the Setup details disclosure is hiding, said on its closed trigger —
   * this app's one rule for every collapsed settings group
   * (`contributing/design-system.md` §Disclosure: "Always, and always with a
   * `badge` saying what is behind it"). Typically a dependency count such as
   * "2 checks" or "1 missing".
   */
  setupBadge?: ReactNode;
  className?: string;
}

/**
 * The runtime card: header, one-line summary at rest, settings when opened.
 *
 * @param props - The card's whole state; see {@link RuntimeCardViewProps}.
 */
export function RuntimeCardView({
  type,
  subtitle,
  ready,
  isDefault,
  onMakeDefault,
  expanded,
  onToggleExpanded,
  summary,
  connectSlot,
  reconnect,
  reconnectPanel,
  model,
  effort,
  trust,
  storesDefaults = true,
  sections,
  renderSection,
  setupDetails,
  setupBadge,
  expiringSignIn,
  className,
}: RuntimeCardViewProps) {
  const descriptor = getRuntimeDescriptor(type);
  const bodyId = useId();
  const [setupOpen, setSetupOpen] = useState(false);

  // Nothing to open is not an expansion: a not-ready runtime has no rows, and
  // without setup details it has nothing behind the chevron either. Offering one
  // anyway would promise a body and deliver a blank.
  const hasBody = ready || !!setupDetails;
  const brokenDefault = isDefault && !ready;

  const sectionNodes = (sections ?? []).flatMap((section) => {
    const node = renderSection?.(section.kind);
    // Sections carry their own boxed chrome, so this wrapper adds none — it only
    // gives the section a place in the body's rhythm. A kind that renders nothing
    // gets no wrapper at all, which is the difference between a silent section
    // and an empty one.
    return node
      ? [
          <div key={section.kind} data-testid={`runtime-card-section-${section.kind}-${type}`}>
            {node}
          </div>,
        ]
      : [];
  });

  return (
    <article
      // The runtime's accent is a theme variable, so it is bound once here and
      // read by class everywhere below rather than sprayed through inline styles.
      style={{ '--runtime-accent': descriptor.accent } as CSSProperties}
      className={cn(
        'bg-card border-border shadow-soft rounded-lg border',
        isDefault && 'border-[var(--runtime-accent)]/40 ring-1 ring-[var(--runtime-accent)]/30',
        className
      )}
      data-testid={`runtime-card-${type}`}
    >
      <RuntimeCardHeader
        type={type}
        subtitle={subtitle}
        ready={ready}
        isDefault={isDefault}
        onMakeDefault={onMakeDefault}
        reconnect={reconnect}
        toggleable={hasBody}
        expanded={expanded}
        onToggleExpanded={onToggleExpanded}
        bodyId={bodyId}
      >
        {!ready ? (
          <span
            className="text-muted-foreground text-xs"
            data-testid={`runtime-card-locked-${type}`}
          >
            {LOCKED_LINE}
          </span>
        ) : (
          !expanded &&
          summary.length > 0 && (
            <span
              className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs"
              data-testid={`runtime-card-summary-${type}`}
            >
              <span className="text-muted-foreground whitespace-nowrap">{SUMMARY_LEAD_IN}</span>
              {summary.map((segment, index) => (
                // Separator and value are ONE flex item, never two: as two, a
                // wrap could leave the middot stranded at the end of a line with
                // the fact it introduces on the next one. Each dot travels with
                // the segment that follows it.
                <span
                  key={`${segment.kind}-${segment.label}`}
                  className="inline-flex max-w-full items-center gap-x-1.5 whitespace-nowrap"
                >
                  {index > 0 && (
                    <span aria-hidden className="text-muted-foreground/60 shrink-0">
                      ·
                    </span>
                  )}
                  <span
                    // Never wraps mid-value: a status chip broken across two
                    // lines reads as two facts (design §6). A value too long for
                    // the card at any width ends in an ellipsis rather than
                    // pushing the card wider than the page.
                    className={cn(
                      'min-w-0 truncate',
                      segment.inherited ? 'text-muted-foreground' : 'text-foreground font-medium'
                    )}
                    data-inherited={segment.inherited === true}
                    data-testid={`runtime-card-summary-segment-${segment.kind}-${index}`}
                  >
                    {segment.label}
                  </span>
                </span>
              ))}
            </span>
          )
        )}
      </RuntimeCardHeader>

      {brokenDefault && (
        <p
          className="flex items-start gap-1.5 px-4 pb-3 text-xs text-amber-700 dark:text-amber-400"
          data-testid={`runtime-default-broken-${type}`}
        >
          <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          {BROKEN_DEFAULT_LINE}
        </p>
      )}

      {expiringSignIn && (
        <p
          className="flex items-start gap-1.5 px-4 pb-3 text-xs text-amber-700 dark:text-amber-400"
          data-testid={`runtime-sign-in-expiring-${type}`}
        >
          <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          {expiringSignIn.timeLeft === null
            ? lapsedSignInLine(descriptor.label)
            : expiringSignInLine(descriptor.label, expiringSignIn.timeLeft)}
        </p>
      )}

      {!ready && connectSlot && <div className="px-4 pb-4">{connectSlot}</div>}
      {ready && reconnectPanel && <div className="px-4 pb-4">{reconnectPanel}</div>}

      {expanded && hasBody && (
        <div
          id={bodyId}
          className="border-border/60 space-y-5 border-t px-4 py-4"
          data-testid={`runtime-card-body-${type}`}
        >
          {/* The two header affordances a phone has no room for, in the one
              place a phone does: the opened body (design §6). Both are
              `sm:hidden` twins of the header's own, never a second control at
              the same width. */}
          {ready && (reconnect || (!isDefault && onMakeDefault)) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:hidden">
              {reconnect && (
                <button
                  type="button"
                  onClick={reconnect.onOpen}
                  className="focus-ring text-muted-foreground hover:text-foreground rounded-sm text-xs underline-offset-2 transition-colors hover:underline"
                  data-testid={`runtime-${RECONNECT_TRIGGERS[reconnect.kind].id}-compact-${type}`}
                >
                  {RECONNECT_TRIGGERS[reconnect.kind].label}
                </button>
              )}
              {!isDefault && onMakeDefault && (
                <button
                  type="button"
                  onClick={onMakeDefault}
                  className="focus-ring text-muted-foreground hover:text-foreground rounded-sm text-xs underline-offset-2 transition-colors hover:underline"
                  data-testid={`runtime-make-default-compact-${type}`}
                >
                  Make default
                </button>
              )}
            </div>
          )}

          {ready &&
            (storesDefaults ? (
              <>
                <ModelRow runtimeType={type} runtimeLabel={descriptor.label} {...model} />
                <EffortRow runtimeType={type} runtimeLabel={descriptor.label} {...effort} />
                <TrustRow runtimeType={type} runtimeLabel={descriptor.label} {...trust} />
                {sectionNodes}
              </>
            ) : (
              <>
                {/* One honest line where three live-looking controls used to be.
                    Their writes went into a section this runtime never declared,
                    so the picker moved, the card said nothing, and the setting
                    was gone on the next read (design §5). */}
                <p
                  className="text-muted-foreground text-xs"
                  data-testid={`runtime-card-no-settings-${type}`}
                >
                  {noSettingsLine(descriptor.label)}
                </p>
                {sectionNodes}
              </>
            ))}

          {setupDetails && (
            // The app's one disclosure card for a settings group
            // (`design-system.md` §Disclosure) rather than a hand-rolled
            // trigger, so this opens the way every other section does.
            <CollapsibleFieldCard
              open={setupOpen}
              onOpenChange={setSetupOpen}
              trigger="Setup details"
              badge={setupBadge}
              className="bg-transparent"
            >
              {setupDetails}
            </CollapsibleFieldCard>
          )}
        </div>
      )}
    </article>
  );
}
