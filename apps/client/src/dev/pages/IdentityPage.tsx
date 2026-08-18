import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { PAGE_CONFIGS } from '../playground-config';
import { IdentityShapeMatrixShowcase } from '../showcases/IdentityMatrixShowcases';
import { IdentityMotionShowcases } from '../showcases/IdentityMotionShowcases';
import { AgentIdentityShowcases } from '../showcases/AgentIdentityShowcases';
import { TeamShowcases } from '../showcases/TeamShowcases';
import { ProfileShowcases } from '../showcases/ProfileShowcases';
import { AccountMenuShowcases, ProfileTabShowcases } from '../showcases/AccountShowcases';
import { IdentityAvatarShowcase } from '../showcases/DataDisplayShowcases';
import { IdentityShowcases } from '../showcases/IdentityShowcases';
import { MessageAuthorAvatarShowcase } from '../showcases/MessageShowcases';
import { AgentIdentityChipShowcase } from '../showcases/StatusLineShowcases';
import { RoomAvatarShowcase, RoomMemberRowShowcase } from '../showcases/RoomsShowcases';

/** This page's own config, so the header and TOC cannot drift from the sidebar. */
const CONFIG = PAGE_CONFIGS.find((config) => config.id === 'identity')!;

/**
 * Every face DorkOS draws, on one page.
 *
 * **The sections under "Also drawn here" are registered to other pages and
 * rendered here** (spec `identity-consistency` §W4.2). A title holds exactly one
 * registry entry, so cross-listing cannot mean registering a section twice — it
 * means rendering the same showcase from two pages. The cost, stated rather than
 * discovered: those sections still group under their own page in ⌘K and their
 * canonical anchor stays `/dev/components#identityavatar` and its neighbours.
 * That is the trade for not breaking a link anybody already has.
 */
export function IdentityPage() {
  return (
    <PlaygroundPageLayout
      title="Identity"
      description={CONFIG.description}
      sections={CONFIG.sections}
    >
      <IdentityShapeMatrixShowcase />
      <IdentityMotionShowcases />
      <AgentIdentityShowcases />
      <TeamShowcases />
      <ProfileShowcases />
      <AccountMenuShowcases />
      <ProfileTabShowcases />

      <div className="border-border border-t pt-8">
        <h2 className="text-sm font-semibold">Also drawn here</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          The rest of the identity language belongs to other pages — the shared discs and mentions
          to Components, the author avatar and the agent chip to Conversation, the room faces to
          Rooms — and is rendered below from those same showcases. Search still finds them under the
          page that owns them, and their links still point there.
        </p>
      </div>

      <IdentityAvatarShowcase />
      <IdentityShowcases />
      <MessageAuthorAvatarShowcase />
      <AgentIdentityChipShowcase />
      <RoomAvatarShowcase />
      <RoomMemberRowShowcase />
    </PlaygroundPageLayout>
  );
}
