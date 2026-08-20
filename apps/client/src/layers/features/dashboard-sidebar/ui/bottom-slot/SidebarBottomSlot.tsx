/**
 * The cockpit's bottom slot: which cards may take it, in what order.
 *
 * Four things used to compete for the bottom of the panel on day one — the
 * getting-started card, the update pill and the profile prompt stacked in the
 * footer, while the promo sat inside the scroller where a long list pushed it
 * out of sight. This is the one place, and one card is shown at a time (spec
 * `sidebar-simplification` D4).
 *
 * **The order is the decision, and it is the whole of it:** a blocked setup
 * beats a version nudge beats a profile nicety beats marketing. The arbitration
 * itself is `BottomSlot` in `shared/ui`, which knows nothing about any of these.
 *
 * @module features/dashboard-sidebar/ui/bottom-slot/SidebarBottomSlot
 */
import { useConfig } from '@/layers/entities/config';
import { usePromoCandidate } from '@/layers/features/feature-promos';
import {
  ProfilePromptCard,
  ProgressCard,
  useOnboarding,
  useProfilePrompt,
} from '@/layers/features/onboarding';
import { BottomSlot, type BottomSlotCandidate } from '@/layers/shared/ui';
import { useUpdateReady } from './use-update-ready';
import { UpdatePill } from './UpdatePill';

/**
 * The sidebar's one bottom card.
 *
 * Mounted by `DashboardSidebar` (so a marketplace body takeover replaces it
 * along with the rest of the body) and, on a phone, at the bottom of the Home
 * panel.
 */
export function SidebarBottomSlot() {
  const { shouldShowGettingStarted, dismiss: dismissOnboarding, isLoading } = useOnboarding();
  const update = useUpdateReady();
  const prompt = useProfilePrompt();
  const promo = usePromoCandidate('dashboard-sidebar');
  const { isLoading: configLoading } = useConfig();

  const candidates: BottomSlotCandidate[] = [
    {
      id: 'getting-started',
      show: shouldShowGettingStarted,
      render: () => <ProgressCard onDismiss={dismissOnboarding} />,
    },
    {
      id: 'update',
      show: update.kind !== 'none',
      render: () => <UpdatePill update={update} />,
    },
    {
      id: 'profile-prompt',
      show: prompt.visible,
      render: () => <ProfilePromptCard prompt={prompt} />,
    },
    promo,
  ];

  // Every candidate above is gated on a server read, and all of them ride the
  // config query. Once it has answered, whatever qualifies is simply there
  // rather than rising into place mid-paint.
  return <BottomSlot candidates={candidates} ready={!isLoading && !configLoading} />;
}
