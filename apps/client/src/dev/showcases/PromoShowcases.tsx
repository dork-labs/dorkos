import { useState } from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { Button } from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { PROMO_REGISTRY, PromoSlot, usePromoSlot } from '@/layers/features/feature-promos';
import type { PromoPlacement } from '@/layers/features/feature-promos';
import { PromoDialog } from '@/layers/features/feature-promos/ui/PromoDialog';

// ---------------------------------------------------------------------------
// Mock context used for the shouldShow column in the registry table
// ---------------------------------------------------------------------------

const MOCK_CTX = {
  hasAdapter: () => false,
  isPulseEnabled: true,
  isMeshEnabled: true,
  isRelayEnabled: true,
  sessionCount: 5,
  agentCount: 3,
  daysSinceFirstUse: 7,
};

// ---------------------------------------------------------------------------
// Registry table
// ---------------------------------------------------------------------------

function RegistryTable() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="text-muted-foreground border-b">
            <th className="pr-4 pb-2 font-medium">ID</th>
            <th className="pr-4 pb-2 font-medium">Title</th>
            <th className="pr-4 pb-2 font-medium">Placements</th>
            <th className="pr-4 pb-2 font-medium">Priority</th>
            <th className="pb-2 font-medium">shouldShow (mock ctx)</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {PROMO_REGISTRY.map((promo) => (
            <tr key={promo.id} className="text-foreground">
              <td className="py-2 pr-4 font-mono">{promo.id}</td>
              <td className="py-2 pr-4">{promo.content.title}</td>
              <td className="py-2 pr-4">
                <div className="flex flex-wrap gap-1">
                  {promo.placements.map((p) => (
                    <span
                      key={p}
                      className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </td>
              <td className="py-2 pr-4">{promo.priority}</td>
              <td className="py-2">
                {promo.shouldShow(MOCK_CTX) ? (
                  <span className="font-medium text-green-600 dark:text-green-400">true</span>
                ) : (
                  <span className="text-muted-foreground">false</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live slot preview — renders the actual PromoSlot component
// ---------------------------------------------------------------------------

interface LiveSlotPreviewProps {
  placement: PromoPlacement;
  maxUnits: number;
}

function LiveSlotPreview({ placement, maxUnits }: LiveSlotPreviewProps) {
  const promos = usePromoSlot(placement, maxUnits);

  return (
    <div className="space-y-3">
      <div className="text-muted-foreground text-xs">
        Qualifying promos: {promos.length} /{' '}
        {PROMO_REGISTRY.filter((p) => p.placements.includes(placement)).length} registered
      </div>
      <PromoSlot placement={placement} maxUnits={maxUnits} />
      {promos.length === 0 && (
        <p className="text-muted-foreground text-xs italic">
          (No promos qualify — check dismissals or global toggle below)
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Override controls — reset dismissals, toggle global setting
// ---------------------------------------------------------------------------

function OverrideControls() {
  const dismissedPromoIds = useAppStore((s) => s.dismissedPromoIds);
  const promoEnabled = useAppStore((s) => s.promoEnabled);
  const setPromoEnabled = useAppStore((s) => s.setPromoEnabled);
  const dismissPromo = useAppStore((s) => s.dismissPromo);

  const resetDismissals = () => {
    try {
      localStorage.removeItem('dorkos-dismissed-promo-ids');
    } catch {}
    // Directly set Zustand slice — no store action exists for this, but
    // setState is the standard escape hatch for dev tooling.
    useAppStore.setState({ dismissedPromoIds: [] });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs font-medium">Global toggle:</span>
          <Button
            variant={promoEnabled ? 'default' : 'outline'}
            size="sm"
            onClick={() => setPromoEnabled(!promoEnabled)}
          >
            {promoEnabled ? 'Enabled' : 'Disabled'}
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs font-medium">
            Dismissed ({dismissedPromoIds.length}):
          </span>
          <Button variant="outline" size="sm" onClick={resetDismissals}>
            Reset dismissals
          </Button>
        </div>
      </div>

      {dismissedPromoIds.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {dismissedPromoIds.map((id) => (
            <span
              key={id}
              className="bg-destructive/10 text-destructive rounded px-2 py-0.5 font-mono text-[10px]"
            >
              {id}
            </span>
          ))}
        </div>
      )}

      <div className="text-muted-foreground text-xs">
        Dismiss a promo card above to see its ID appear here. Use &quot;Reset dismissals&quot; to
        restore it.
      </div>

      <ShowcaseLabel>Dismiss individual promos</ShowcaseLabel>
      <div className="flex flex-wrap gap-2">
        {PROMO_REGISTRY.map((promo) => {
          const isDismissed = dismissedPromoIds.includes(promo.id);
          return (
            <Button
              key={promo.id}
              variant="outline"
              size="sm"
              disabled={isDismissed}
              onClick={() => dismissPromo(promo.id)}
            >
              {isDismissed ? `${promo.id} (dismissed)` : `Dismiss ${promo.id}`}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog preview buttons
// ---------------------------------------------------------------------------

function DialogPreviews() {
  const dialogPromos = PROMO_REGISTRY.filter((p) => p.action.type === 'dialog');
  const [openPromoId, setOpenPromoId] = useState<string | null>(null);

  const activePromo = openPromoId ? (dialogPromos.find((p) => p.id === openPromoId) ?? null) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {dialogPromos.map((promo) => (
          <Button
            key={promo.id}
            variant="outline"
            size="sm"
            onClick={() => setOpenPromoId(promo.id)}
          >
            {promo.content.title}
          </Button>
        ))}
      </div>

      {activePromo && activePromo.action.type === 'dialog' && (
        <PromoDialog
          promo={activePromo}
          open={true}
          onOpenChange={(open) => {
            if (!open) setOpenPromoId(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/** Feature promo system showcases: registry, slot previews, override controls, dialog previews. */
export function PromoShowcases() {
  return (
    <>
      <PlaygroundSection
        title="Promo Registry"
        description="All registered promos with their placements, priority, and shouldShow result against a representative mock context."
      >
        <ShowcaseDemo>
          <RegistryTable />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="PromoSlot — dashboard-main"
        description="Responsive 2-col grid layout with section header. Dismiss a card to see it disappear with animation."
      >
        <ShowcaseDemo responsive>
          <LiveSlotPreview placement="dashboard-main" maxUnits={4} />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="PromoSlot — dashboard-sidebar"
        description="Compact vertical stack, no section header, no dismiss button."
      >
        <ShowcaseDemo>
          <div className="max-w-xs">
            <LiveSlotPreview placement="dashboard-sidebar" maxUnits={3} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="PromoSlot — agent-sidebar"
        description="Same compact format as dashboard-sidebar, rendered in the agent session sidebar."
      >
        <ShowcaseDemo>
          <div className="max-w-xs">
            <LiveSlotPreview placement="agent-sidebar" maxUnits={2} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Override Controls"
        description="Reset dismissals and toggle the global promo setting to test slot filtering. Changes persist to localStorage."
      >
        <ShowcaseDemo>
          <OverrideControls />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Dialog Previews"
        description="Open each promo's dialog content directly without going through a PromoCard."
      >
        <ShowcaseDemo>
          <DialogPreviews />
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
