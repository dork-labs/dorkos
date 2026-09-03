import { useState } from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { BottomSlot, Button, SidebarContent } from '@/layers/shared/ui';
import type { BottomSlotCandidate } from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { usePromoDismissals, useUpdateConfig } from '@/layers/entities/config';
import { PROMO_REGISTRY, PromoCard, usePromoSlot } from '@/layers/features/feature-promos';
import type { PromoPlacement } from '@/layers/features/feature-promos';
import { PromoDialog } from '@/layers/features/feature-promos/ui/PromoDialog';
import { UpdatePill } from '@/layers/features/dashboard-sidebar';
import { ProfilePromptCard, ProgressCard } from '@/layers/features/onboarding';
import type { ProfilePromptApi } from '@/layers/features/onboarding';

// ---------------------------------------------------------------------------
// Mock context used for the shouldShow column in the registry table
// ---------------------------------------------------------------------------

const MOCK_CTX = {
  hasAdapter: () => false,
  isTasksEnabled: true,
  isMeshEnabled: true,
  isRelayEnabled: true,
  sessionCount: 5,
  agentCount: 3,
  taskCount: 0,
  daysSinceFirstUse: 7,
  // A browser with no tunnel set up — the one state in which `remote-access`
  // qualifies, now that it has a real trigger instead of `() => true`.
  isDesktopApp: false,
  remoteAccessConfigured: false,
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
                      className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-3xs"
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
// Live preview — the real promo this install qualifies for
// ---------------------------------------------------------------------------

/** How many promos a bottom slot shows. Mirrors the slot's own cap. */
const SLOT_UNITS = 1;

function LiveSlotPreview({ placement }: { placement: PromoPlacement }) {
  const promos = usePromoSlot(placement, SLOT_UNITS);
  const registered = PROMO_REGISTRY.filter((p) => p.placements.includes(placement)).length;
  const [top] = promos;

  return (
    <div className="space-y-3">
      <div className="text-muted-foreground text-xs">
        Showing {promos.length} of {registered} registered for this placement (the slot takes one)
      </div>
      {top === undefined ? (
        <p className="text-muted-foreground text-xs italic">
          (No promo qualifies — check dismissals or the global toggle below)
        </p>
      ) : (
        <PromoCard promo={top} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The bottom slot, in a real 272px panel with a list that overflows it
// ---------------------------------------------------------------------------

/** The slot's four candidates, in priority order, as the playground names them. */
const SLOT_STATES = ['getting-started', 'update', 'profile-prompt', 'promo', 'empty'] as const;

type SlotState = (typeof SLOT_STATES)[number];

/** A profile prompt frozen mid-ask, so the card can be drawn without a config write. */
const MOCK_PROMPT: ProfilePromptApi = {
  visible: true,
  phase: 'ask',
  selected: [],
  setSelected: () => {},
  confirmLabel: 'Save',
  errorMessage: null,
  save: () => {},
  skip: () => {},
};

function BottomSlotInPanel() {
  const [state, setState] = useState<SlotState>('getting-started');
  const promo = PROMO_REGISTRY[0]!;

  // Exactly the shape `SidebarBottomSlot` builds, with the qualification
  // hard-coded so each candidate can be looked at on its own.
  const candidates: BottomSlotCandidate[] = [
    {
      id: 'getting-started',
      show: state === 'getting-started',
      render: () => <ProgressCard onDismiss={() => setState('empty')} />,
    },
    {
      id: 'update',
      show: state === 'update',
      render: () => (
        <UpdatePill
          update={{ kind: 'command', latestVersion: '9.9.9', dismiss: () => setState('empty') }}
        />
      ),
    },
    {
      id: 'profile-prompt',
      show: state === 'profile-prompt',
      render: () => <ProfilePromptCard prompt={MOCK_PROMPT} />,
    },
    {
      id: `promo:${promo.id}`,
      show: state === 'promo',
      render: () => <PromoCard promo={promo} />,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {SLOT_STATES.map((option) => (
          <Button
            key={option}
            size="sm"
            variant={state === option ? 'default' : 'outline'}
            onClick={() => setState(option)}
          >
            {option}
          </Button>
        ))}
      </div>

      {/* **A 272px panel with more rows than fit.** This is the whole point of
          the showcase: the promo used to be the last child inside the scroller,
          so on a real cockpit it was below the fold and nobody saw it — and the
          old playground drew the slot free-floating in a `max-w-xs` box, which
          is exactly why the bug was invisible here. Scroll the list: the card
          stays put. */}
      <div className="bg-sidebar text-sidebar-foreground flex h-80 w-[272px] flex-col rounded-lg border">
        <SidebarContent className="px-2 py-3">
          <div className="space-y-1">
            {Array.from({ length: 30 }, (_, i) => (
              <div
                key={i}
                className="text-sidebar-foreground/70 truncate rounded-md px-2 py-1.5 text-[13px]"
              >
                A row that pushes the list past the fold #{i + 1}
              </div>
            ))}
          </div>
        </SidebarContent>
        <BottomSlot candidates={candidates} ready />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Override controls — reset dismissals, toggle global setting
// ---------------------------------------------------------------------------

function OverrideControls() {
  const { dismissedIds: dismissedPromoIds, dismissPromo } = usePromoDismissals();
  const promoEnabled = useAppStore((s) => s.promoEnabled);
  const setPromoEnabled = useAppStore((s) => s.setPromoEnabled);
  const updateConfig = useUpdateConfig();

  // Dismissals are config now, so undoing them is a config write. There is no
  // product affordance for un-dismissing — deliberately, saying no should stay
  // said — which is why this reaches for the patch directly.
  const resetDismissals = () => {
    updateConfig.mutate({ ui: { promos: { dismissedIds: [] } } });
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
              className="bg-destructive/10 text-destructive rounded px-2 py-0.5 font-mono text-3xs"
            >
              {id}
            </span>
          ))}
        </div>
      )}

      <div className="text-muted-foreground text-xs">
        Press the × on a card above, or a button below, to see its id appear here. These are stored
        in your config (<code>ui.promos.dismissedIds</code>), not in this browser, so a dismissal
        holds on every device. &quot;Reset dismissals&quot; writes the list back to empty.
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
        title="Bottom slot in a 272px panel with an overflowing list"
        description="The real slot, pinned between a scroller and the footer, cycling through its four candidates in priority order: getting-started progress > update pill > profile prompt > promo. Scroll the list — the card does not move."
      >
        <ShowcaseDemo>
          <BottomSlotInPanel />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Promo card — dashboard-sidebar"
        description="The promo this install actually qualifies for on the cockpit panel, with its dismiss control."
      >
        <ShowcaseDemo>
          <div className="max-w-xs">
            <LiveSlotPreview placement="dashboard-sidebar" />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Promo card — agent-sidebar"
        description="The same card in the Obsidian embed's placement, which is the only candidate that slot has."
      >
        <ShowcaseDemo>
          <div className="max-w-xs">
            <LiveSlotPreview placement="agent-sidebar" />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Override Controls"
        description="Reset dismissals and toggle the global promo setting to test slot filtering. Dismissals persist to your config; the global toggle is per-browser."
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
