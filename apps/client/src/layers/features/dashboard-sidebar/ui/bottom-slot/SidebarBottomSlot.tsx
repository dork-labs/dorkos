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
 * beats a version nudge beats a profile nicety beats marketing. Of the two
 * profile niceties, who you are comes before what you do: a name and a handle
 * change how every message you write is shown, and the role card simply takes
 * its turn once this one is gone. The arbitration
 * itself is `BottomSlot` in `shared/ui`, which knows nothing about any of these.
 *
 * **The DorkOS community comes after personal setup** (DOR-2873). After a first
 * run that set up an AI, the offer to join the official space rides inside the
 * Getting started card. Once that card is gone, the offer takes its own turn
 * here, after the name and role prompts, so it is never on screen twice.
 *
 * @module features/dashboard-sidebar/ui/bottom-slot/SidebarBottomSlot
 */
import { OfficialSpaceOfferCard } from '@/layers/entities/community';
import { usePromoCandidate } from '@/layers/features/feature-promos';
import {
  IdentityPromptCard,
  ProfilePromptCard,
  ProgressCard,
  useIdentityPrompt,
  useOnboarding,
  useFirstRunSpaceOffer,
  useProfilePrompt,
} from '@/layers/features/onboarding';
import { BottomSlot, type BottomSlotCandidate } from '@/layers/shared/ui';
import { useBootState } from '../../model/boot/use-boot-state';
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
  const { shouldShowGettingStarted, dismiss: dismissOnboarding } = useOnboarding();
  const gettingStartedCardShown = shouldShowGettingStarted;
  const update = useUpdateReady();
  // The prompts wait for the card, so they are told whether it is on screen.
  const identityPrompt = useIdentityPrompt({ gettingStartedCardShown });
  const prompt = useProfilePrompt({ gettingStartedCardShown });
  const spaceOffer = useFirstRunSpaceOffer();
  const promo = usePromoCandidate('dashboard-sidebar');
  const boot = useBootState();

  const candidates: BottomSlotCandidate[] = [
    {
      id: 'getting-started',
      show: gettingStartedCardShown,
      render: () => <ProgressCard onDismiss={dismissOnboarding} />,
    },
    {
      id: 'update',
      show: update.kind !== 'none',
      render: () => <UpdatePill update={update} />,
    },
    {
      id: 'identity-prompt',
      show: identityPrompt.visible,
      render: () => <IdentityPromptCard prompt={identityPrompt} />,
    },
    {
      id: 'profile-prompt',
      show: prompt.visible,
      render: () => <ProfilePromptCard prompt={prompt} />,
    },
    {
      // Inside the card while it shows; here only once it is gone.
      id: 'official-space-offer',
      show: spaceOffer.due && !gettingStartedCardShown,
      render: () => <OfficialSpaceOfferCard className="bg-secondary/60 rounded-lg" />,
    },
    // A promo waits while the offer's connection list is still loading, so the
    // slot never shows a promo and then swaps it for the offer a beat later.
    { ...promo, show: promo.show && !spaceOffer.pending },
  ];

  // **The same fact the panel above paints on** (spec D6). Every candidate here
  // is gated on a server read, so a slot that decided for itself when it was
  // ready could rise into place a beat after the rows it sits under. Keyed off
  // the boot gate, the card is simply there when the panel is.
  return <BottomSlot candidates={candidates} ready={boot.settled} />;
}
