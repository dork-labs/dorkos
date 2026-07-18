/**
 * The Shape switcher — the in-cockpit control for applying/switching Shapes
 * (DOR-355 §5). Lists installed Shapes, marks the active one, applies on pick,
 * offers the arrival agent, surfaces degradation notes honestly, and re-applies
 * the active Shape via "Reset to defaults".
 *
 * @module features/shapes/ui/ShapeSwitcherDialog
 */
import { useCallback, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Shapes, ArrowRight, Sparkles, Loader2, TriangleAlert, Store } from 'lucide-react';
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
import { useAgentCreationStore } from '@/layers/shared/model';
import { useShapes } from '@/layers/entities/shapes';
import { useApplyShape } from '../model/use-apply-shape';
import { useSwitchAgentCwd } from '../model/use-switch-agent-cwd';

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
  const openAgentCreation = useAgentCreationStore((s) => s.open);

  // The last apply's result — kept while the dialog stays open so the arrival
  // offer + notes persist (toasts vanish). Cleared when the dialog closes.
  const [result, setResult] = useState<ApplyShapeResult | null>(null);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) setResult(null);
      onOpenChange(next);
    },
    [onOpenChange]
  );

  const handleApply = useCallback(
    (shape: InstalledShapeSummary) => {
      applyShape.mutate({ name: shape.name, label: shapeLabel(shape) }, { onSuccess: setResult });
    },
    [applyShape]
  );

  const pendingName = applyShape.isPending ? applyShape.variables?.name : undefined;
  const activeShape = shapes?.find((s) => s.active);
  const arrival = result?.offeredAgents.find((a) => a.arrival);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <DialogHeader className="space-y-1 px-5 pt-5">
          <DialogTitle className="flex items-center gap-2">
            <Shapes className="text-muted-foreground size-[--size-icon-sm]" />
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
                <Shapes className="text-muted-foreground size-[--size-icon-md]" />
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
                <Store className="size-[--size-icon-xs]" />
                Browse Marketplace
              </Button>
            </div>
          ) : (
            <ul className="space-y-0.5">
              {shapes.map((shape) => {
                const isPending = pendingName === shape.name;
                return (
                  <li key={shape.name}>
                    <button
                      type="button"
                      disabled={applyShape.isPending}
                      onClick={() => handleApply(shape)}
                      className={cn(
                        'group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors',
                        'focus-ring hover:bg-accent disabled:pointer-events-none',
                        shape.active && 'bg-accent/60'
                      )}
                    >
                      <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                        <Shapes className="size-[--size-icon-sm]" />
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
                        <Loader2 className="text-muted-foreground size-[--size-icon-sm] shrink-0 animate-spin" />
                      ) : shape.active ? (
                        <Badge variant="secondary" className="shrink-0">
                          Active
                        </Badge>
                      ) : (
                        <ArrowRight className="text-muted-foreground size-[--size-icon-sm] shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
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
                <Sparkles className="text-primary mt-0.5 size-[--size-icon-sm] shrink-0" />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="text-sm">
                    This Shape suggests the{' '}
                    <span className="font-medium">{arrival.displayName}</span> agent.
                  </p>
                  {arrival.satisfied && arrival.projectPath ? (
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
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        openAgentCreation();
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
                <TriangleAlert className="size-[--size-icon-xs]" />
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

        {/* Reset re-applies the active Shape's own defaults (idempotent). */}
        {activeShape && (
          <div className="border-border border-t px-5 py-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={applyShape.isPending}
              onClick={() => handleApply(activeShape)}
              className="text-muted-foreground"
            >
              Reset {shapeLabel(activeShape)} to defaults
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
