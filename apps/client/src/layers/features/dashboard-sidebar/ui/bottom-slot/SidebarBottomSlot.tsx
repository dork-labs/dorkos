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
 * **One "Getting started" list at a time** (DOR-2845). While the panel's own
 * Getting started zone still has a suggestion, the card here steps aside and
 * the next one in line takes the slot, the name and role prompts included. The
 * card comes back once the zone has nothing left to suggest.
 *
 * @module features/dashboard-sidebar/ui/bottom-slot/SidebarBottomSlot
 */
import { usePromoCandidate } from '@/layers/features/feature-promos';
import {
  IdentityPromptCard,
  ProfilePromptCard,
  ProgressCard,
  useIdentityPrompt,
  useOnboarding,
  useProfilePrompt,
} from '@/layers/features/onboarding';
import { BottomSlot, type BottomSlotCandidate } from '@/layers/shared/ui';
import type { SidebarModel } from '../../model/build-sidebar-model';
import { useBootState } from '../../model/boot/use-boot-state';
import { useUpdateReady } from './use-update-ready';
import { UpdatePill } from './UpdatePill';

/**
 * The sidebar's one bottom card.
 *
 * Mounted by `DashboardSidebar` (so a marketplace body takeover replaces it
 * along with the rest of the body) and, on a phone, at the bottom of the Home
 * panel.
 *
 * @param props.model - The panel's model, read only for whether its own
 *   Getting started zone still has something to suggest.
 */
export function SidebarBottomSlot({ model }: { model: SidebarModel }) {
  const { shouldShowGettingStarted, dismiss: dismissOnboarding } = useOnboarding();
  const gettingStartedCardShown = shouldShowGettingStarted && !model.gettingStartedPending;
  const update = useUpdateReady();
  // The prompts wait for the card, so they are told whether it is really on
  // screen — or, held back for the list, it would ask them nowhere.
  const identityPrompt = useIdentityPrompt({ gettingStartedCardShown });
  const prompt = useProfilePrompt({ gettingStartedCardShown });
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
    promo,
  ];

  // **The same fact the panel above paints on** (spec D6). Every candidate here
  // is gated on a server read, so a slot that decided for itself when it was
  // ready could rise into place a beat after the rows it sits under. Keyed off
  // the boot gate, the card is simply there when the panel is.
  return <BottomSlot candidates={candidates} ready={boot.settled} />;
}
