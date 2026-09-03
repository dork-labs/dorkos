/**
 * The Shape switcher — the in-cockpit control for applying/switching Shapes
 * (DOR-355 §5). Lists installed Shapes, marks the active one, applies on pick,
 * offers the arrival agent, surfaces degradation notes honestly, and re-applies
 * the active Shape via "Reset to defaults".
 *
 * @module features/shapes/ui/ShapeSwitcherDialog
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  Shapes,
  ArrowRight,
  Copy,
  Sparkles,
  Loader2,
  TriangleAlert,
  Store,
  CalendarClock,
} from 'lucide-react';
import type { ApplyShapeResult, InstalledShapeSummary } from '@dorkos/shared/marketplace-schemas';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Skeleton,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useAgentCreationStore, useAppStore } from '@/layers/shared/model';
import { useShapes } from '@/layers/entities/shapes';
import { useApplyShape } from '../model/use-apply-shape';
import { useForkShape } from '../model/use-fork-shape';
import { useSwitchAgentCwd } from '../model/use-switch-agent-cwd';
import { ShapeForkForm } from './ShapeForkForm';

/** Props for {@link ShapeSwitcherDialog} — the registry dialog contract. */
export interface ShapeSwitcherDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The label shown for a Shape (its display name, falling back to the slug). */
function shapeLabel(shape: InstalledShapeSummary): string {
  return shape.displayName ?? shape.name;
}

/**
 * The Shape switcher dialog.
 *
 * @param props - Open state + change handler (driven by the app store / DialogHost).
 */
export function ShapeSwitcherDialog({ open, onOpenChange }: ShapeSwitcherDialogProps) {
  const navigate = useNavigate();
  const { data: shapes, isLoading, isError } = useShapes();
  const applyShape = useApplyShape();
  const switchAgent = useSwitchAgentCwd();
  const openWithSeed = useAgentCreationStore((s) => s.openWithSeed);
  // The Shape an "Apply…" affordance asked us to land on (install toast /
  // installed list). Its card is highlighted and scrolled into view — the user
  // still confirms by clicking; we never auto-apply.
  const focusShape = useAppStore((s) => s.shapeSwitcherFocus);

  // The last apply's result — kept while the dialog stays open so the arrival
  // offer + notes persist (toasts vanish). Cleared when the dialog closes.
  const [result, setResult] = useState<ApplyShapeResult | null>(null);
  // The Shape that produced `result` — labels the offer as "offered by …".
  const [appliedLabel, setAppliedLabel] = useState<string | null>(null);
  // Whether the footer is showing the "make your own version" form.
  const [forkOpen, setForkOpen] = useState(false);
  // Whether the fork form's name field is on screen to render a refusal itself.
  // Read at failure time, so it lives in a ref rather than a closure.
  const inlineForkErrorRef = useRef(false);
  // The fork mutation lives HERE, not in the form (DOR-453): a copy can still be
  // in flight after the form is dismissed, and TanStack drops a per-call
  // callback the moment its observer unmounts. Owning it one level up keeps the
  // request — and its report — alive across every way out of the form.
  const forkShape = useForkShape({
    isInlineErrorVisible: () => inlineForkErrorRef.current,
  });

  // Armed by the ways OUT of the form that put the footer back at rest, so the
  // trigger can take focus again the moment it remounts (DOR-513).
  //
  // Leaving the form removes the input it was focused on while the switcher
  // stays open, and Radix's FocusScope answers a removed focus owner with a
  // generic fallback: it focuses the DialogContent container. Tab from there
  // restarts at the top of the Shape list — place-loss on a control people use
  // repeatedly (fork, adjust, fork again).
  const restoreForkFocusRef = useRef(false);

  /** Leave the form and hand focus back to the trigger that opened it. */
  const closeForkForm = useCallback(() => {
    restoreForkFocusRef.current = true;
    setForkOpen(false);
  }, []);

  // A callback ref, not a stored ref read from an effect: the trigger UNMOUNTS
  // while the form is open, so at close time the node to focus does not exist
  // yet. React invokes this in the same commit that re-creates it — still inside
  // the keypress's own task, ahead of the FocusScope MutationObserver that would
  // otherwise claim the container, since that one only acts on focus it finds
  // parked on `document.body`.
  const focusForkTriggerOnReturn = useCallback((el: HTMLButtonElement | null) => {
    if (!el || !restoreForkFocusRef.current) return;
    restoreForkFocusRef.current = false;
    el.focus();
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setResult(null);
        setAppliedLabel(null);
        setForkOpen(false);
      }
      onOpenChange(next);
    },
    [onOpenChange]
  );

  const handleApply = useCallback(
    (shape: InstalledShapeSummary) => {
      const label = shapeLabel(shape);
      // Applying moves the active Shape, and the fork form only ever targets the
      // active one. Leaving it open would silently re-aim a half-typed name at a
      // Shape the person never asked to copy — so close it first.
      //
      // Deliberately NOT `closeForkForm`: picking a Shape is not backing out of
      // the form, and focus belongs on the row that was just chosen rather than
      // being yanked down to the footer. The explicit disarm makes that true by
      // construction — without it, a stale arm (a fork settling after Escape
      // already consumed the remount) would fire here (DOR-513 review).
      restoreForkFocusRef.current = false;
      setForkOpen(false);
      applyShape.mutate(
        { name: shape.name, label },
        {
          onSuccess: (r) => {
            // Auto-follow (opt-in) already navigated us to the Shape's arrival
            // agent inside applyShapeAction. The switcher's job is done, so it
            // dismisses itself rather than lingering as dead chrome over the
            // place it just took you.
            const followed = r.offeredAgents.some(
              (a) => a.arrival && a.autoFollow && a.projectPath
            );
            if (followed) {
              handleOpenChange(false);
              return;
            }
            setResult(r);
            setAppliedLabel(label);
          },
        }
      );
    },
    [applyShape, handleOpenChange]
  );

  // Callback ref for the highlighted card — React invokes it with the element
  // the moment the focused card renders, so we scroll it into view without an
  // effect that would fight the dialog's open animation.
  const scrollFocusedIntoView = useCallback((el: HTMLButtonElement | null) => {
    el?.scrollIntoView({ block: 'nearest' });
  }, []);

  const pendingName = applyShape.isPending ? applyShape.variables?.name : undefined;
  const activeShape = shapes?.find((s) => s.active);

  // The name field is on screen exactly when the dialog is open and the footer is
  // showing the form — closing either one unmounts it.
  //
  // Written during render rather than from an effect: a copy can fail in the
  // microtask right after it was sent, long before effects flush, and answering
  // one render too late means a failure nobody hears about. The write is pure —
  // same inputs, same value — so a StrictMode double render is a no-op, and
  // nothing renders from the ref.
  // eslint-disable-next-line react-hooks/refs -- deliberate latest-value mirror
  inlineForkErrorRef.current = open && forkOpen;

  // A pending restore only means anything while the switcher is on screen. Left
  // armed across a close it would fire on the NEXT open, when the trigger
  // remounts — stealing focus from the dialog's own entry point. A copy that
  // succeeds after you hit ✕ arms exactly that way (its `onSuccess` leaves a
  // form that is already gone), and an outside actor closing the dialog (the
  // palette, or an agent's `control_ui` writing the store) never routes through
  // `handleOpenChange` at all. Answering it here covers both.
  // eslint-disable-next-line react-hooks/refs -- deliberate latest-value mirror
  if (!open) restoreForkFocusRef.current = false;
  useEffect(
    () => () => {
      // Defensive. `DialogHost` renders the switcher unconditionally for the app's
      // whole lifetime, so this is near-unreachable — it just costs two lines to
      // hold the invariant without depending on that.
      inlineForkErrorRef.current = false;
    },
    []
  );

  const arrival = result?.offeredAgents.find((a) => a.arrival);
  // Show "Open" when the arrival agent exists. No auto-follow guard is needed
  // here: the `onSuccess` early-return skips `setResult` on the auto-follow
  // path, so `result` (and this `arrival`) never holds an auto-followed agent —
  // we never render a redundant "Open" for a place we already landed on.
  // "Set up" shows only for an unsatisfied offer (no agent to open yet).
  const showOpenArrival = Boolean(arrival?.satisfied && arrival.projectPath);
  const showSetUpArrival = Boolean(arrival && !arrival.satisfied);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="gap-0 p-0 sm:max-w-md"
        onEscapeKeyDown={(event) => {
          // Escape backs out one layer. With the name form open it folds the
          // form away and leaves you where you were in the list; a second
          // Escape leaves the switcher. Mid-copy is no exception — nothing here
          // is ever allowed to hold you in.
          if (!forkOpen) return;
          event.preventDefault();
          closeForkForm();
        }}
      >
        <DialogHeader className="space-y-1 px-5 pt-5">
          <DialogTitle className="flex items-center gap-2">
            <Shapes className="text-muted-foreground size-(--size-icon-sm)" />
            Shapes
          </DialogTitle>
          <DialogDescription>
            Switch what DorkOS is set up for. A Shape arranges your workspace, turns on its
            extensions, and offers its agents.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[min(60vh,26rem)] overflow-y-auto px-3 py-3">
          {isLoading ? (
            <div className="space-y-1.5 px-2">
              <Skeleton className="h-12 w-full rounded-md" />
              <Skeleton className="h-12 w-full rounded-md" />
            </div>
          ) : isError ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-sm">
              Couldn&rsquo;t load your Shapes. Check that the DorkOS server is running.
            </p>
          ) : !shapes || shapes.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
              <span className="bg-muted flex size-11 items-center justify-center rounded-full">
                <Shapes className="text-muted-foreground size-(--size-icon-md)" />
              </span>
              <div className="space-y-1">
                <p className="text-sm font-medium">No Shapes installed yet</p>
                <p className="text-muted-foreground text-sm">
                  Install one from the Marketplace to switch your whole setup at once.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  handleOpenChange(false);
                  void navigate({ to: '/marketplace' });
                }}
              >
                <Store className="size-(--size-icon-xs)" />
                Browse Marketplace
              </Button>
            </div>
          ) : (
            <ul className="space-y-0.5">
              {shapes.map((shape) => {
                const isPending = pendingName === shape.name;
                const isHighlighted = focusShape === shape.name;
                return (
                  <li key={shape.name}>
                    <button
                      type="button"
                      ref={isHighlighted ? scrollFocusedIntoView : undefined}
                      data-highlighted={isHighlighted || undefined}
                      disabled={applyShape.isPending}
                      onClick={() => handleApply(shape)}
                      className={cn(
                        'group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors',
                        'focus-ring hover:bg-accent disabled:pointer-events-none',
                        shape.active && 'bg-accent/60',
                        isHighlighted && 'ring-primary ring-2'
                      )}
                    >
                      <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                        <Shapes className="size-(--size-icon-sm)" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {shapeLabel(shape)}
                        </span>
                        {shape.lineage && (
                          <span className="text-muted-foreground block truncate text-xs">
                            forked from {shape.lineage.forkedFrom}
                          </span>
                        )}
                      </span>
                      {isPending ? (
                        <Loader2 className="text-muted-foreground size-(--size-icon-sm) shrink-0 animate-spin" />
                      ) : shape.active ? (
                        <Badge variant="secondary" className="shrink-0">
                          Active
                        </Badge>
                      ) : (
                        <ArrowRight className="text-muted-foreground size-(--size-icon-sm) shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Arrival offer — the Shape's default agent, offered never forced. */}
          {arrival && (
            <div className="border-border bg-card mt-3 rounded-md border p-3">
              <div className="flex items-start gap-2.5">
                <Sparkles className="text-primary mt-0.5 size-(--size-icon-sm) shrink-0" />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="text-sm">
                    This Shape suggests the{' '}
                    <span className="font-medium">{arrival.displayName}</span> agent.
                  </p>
                  {/* The server-derived cadence, in plain words — shown only
                      when the Shape declares a describable schedule for this
                      agent. Quiet secondary line, matching the arrival ledger. */}
                  {arrival.scheduleSummary && (
                    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                      <CalendarClock className="size-(--size-icon-xs) shrink-0" />
                      {arrival.scheduleSummary}
                    </p>
                  )}
                  {showOpenArrival && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        switchAgent(arrival.projectPath!);
                        handleOpenChange(false);
                      }}
                    >
                      Open {arrival.displayName}
                    </Button>
                  )}
                  {showSetUpArrival && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        openWithSeed({
                          // Prefill the creation dialog from the Shape's own
                          // template; the resolved display name wins and the
                          // human cadence line rides along.
                          template: {
                            ...arrival.template,
                            displayName: arrival.displayName,
                            schedule: arrival.scheduleSummary,
                          },
                          origin: 'shape-offer',
                          sourceLabel: appliedLabel ?? undefined,
                        });
                        handleOpenChange(false);
                      }}
                    >
                      Set up {arrival.displayName}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Degradation notes (§7) — surfaced honestly, not just to the console. */}
          {result && result.warnings.length > 0 && (
            <div className="border-border bg-muted/40 mt-3 space-y-1.5 rounded-md border p-3">
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
                <TriangleAlert className="size-(--size-icon-xs)" />
                {result.warnings.length === 1 ? '1 note' : `${result.warnings.length} notes`}
              </p>
              <ul className="space-y-1">
                {result.warnings.map((warning, i) => (
                  <li key={i} className="text-muted-foreground text-xs">
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/*
          Footer actions for the ACTIVE Shape only: reset it to its own defaults
          (idempotent), or save the arrangement you are living in as your own
          copy. Both are about the Shape you are in — copying a Shape you are not
          using captures nothing, and stays a CLI capability.
        */}
        {activeShape && (
          <div className="border-border border-t px-5 py-3">
            {forkOpen ? (
              // Keyed so the active Shape changing from OUTSIDE the dialog (an
              // agent's `control_ui apply_layout`, or another client applying
              // and this one refetching) re-seeds the suggested name. Without
              // it the form would silently re-aim at the new Shape while the
              // input still read the old one's name. `handleApply` covers the
              // in-dialog path; these two guards are complementary.
              <ShapeForkForm
                key={activeShape.name}
                shapeName={activeShape.name}
                // A refusal names a Shape, so it may only be shown against the
                // Shape it was about. The `key` below re-seeds the field when the
                // active Shape moves under us; the mutation lives above that
                // remount now, so without this gate a refusal about one Shape
                // would sit under a field aimed at another.
                serverError={
                  forkShape.variables?.name === activeShape.name
                    ? (forkShape.error?.message ?? null)
                    : null
                }
                // Deliberately NOT gated by Shape identity the way `serverError`
                // is, though the asymmetry looks like an oversight. `pending` is
                // what serializes forks through this one shared mutation: a
                // second `mutate()` while the first is in flight detaches the
                // observer from it (`mutationObserver.js` `mutate()` calls
                // `removeObserver` on the previous mutation), so the first
                // request's failure would reach neither the field nor a toast —
                // the DOR-453 silent failure, reintroduced. Blocking Create
                // while ANY fork is in flight is the cost of one mutation.
                pending={forkShape.isPending}
                onCreate={(as) =>
                  forkShape.mutate({ name: activeShape.name, as }, { onSuccess: closeForkForm })
                }
                onDone={closeForkForm}
                onNameEdited={() => {
                  if (forkShape.error) forkShape.reset();
                }}
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={applyShape.isPending}
                  onClick={() => handleApply(activeShape)}
                  className="text-muted-foreground"
                >
                  Reset {shapeLabel(activeShape)} to defaults
                </Button>
                <Button
                  ref={focusForkTriggerOnReturn}
                  variant="ghost"
                  size="sm"
                  disabled={applyShape.isPending}
                  onClick={() => {
                    // The mutation now outlives the form, so a settled refusal
                    // would still be sitting under the field. Clear it — but only
                    // if it HAS settled. Resetting a copy that is still in flight
                    // detaches the observer, which drops the error state the field
                    // renders from while the form's return tells the toast path
                    // that a field exists. The failure would land nowhere at all.
                    if (!forkShape.isPending) forkShape.reset();
                    setForkOpen(true);
                  }}
                  className="text-muted-foreground"
                >
                  <Copy className="size-(--size-icon-xs)" />
                  Make your own version
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
