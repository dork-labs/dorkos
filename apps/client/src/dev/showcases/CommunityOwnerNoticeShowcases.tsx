/**
 * The owner's warning that someone asked the host to make someone else the owner of their
 * community (DOR-2543), at the top of the community's page.
 *
 * Nobody can produce one on demand: it needs a host to ask, a notice to be sent, and this
 * install to be the owner's. The REAL banner, fed one owner connection per state, so every
 * sentence is the one the app draws. Dates are pinned to UTC so the copy reads the same for
 * every reviewer.
 *
 * @module dev/showcases/CommunityOwnerNoticeShowcases
 */
import type {
  CommunityConnectionDescriptor,
  CommunityConnectionOwnerNotice,
} from '@dorkos/shared/community-connections';
import { CommunityOwnerNoticeBanner } from '@/layers/widgets/room-view';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

const ALL = { read: true, post: true, enrollAgent: true, stream: true };
const DATES = { locale: 'en-US', timeZone: 'UTC' };

type OpenNotice = Extract<CommunityConnectionOwnerNotice, { state: 'open' }>;

function ownerConnection(
  ref: string,
  lifecycle: 'active' | 'archived',
  notice: Partial<OpenNotice> = {}
): CommunityConnectionDescriptor {
  return {
    ref: ref as CommunityConnectionDescriptor['ref'],
    remoteCommunityId: `${ref}-id`,
    label: 'Night shift',
    pinnedOrigin: 'https://night-shift.example.com',
    connectedHumanMemberId: 'owner',
    status: 'connected',
    expiresAt: null,
    access: {
      state: 'verified',
      effective: ALL,
      lastKnown: { lifecycle, capabilities: ALL, verifiedAt: '2026-09-30T00:00:00.000Z' },
    },
    attention: { state: 'unavailable', unreadCount: null, mentionCount: null, verifiedAt: null },
    ownerNotice: {
      state: 'open',
      replacementId: `${ref}-request`,
      requestState: 'waiting',
      requestedAt: '2026-09-20T10:00:00.000Z',
      claimableAfter: '2026-10-04T10:00:00.000Z',
      claimReissuedAt: null,
      options: { keep: true, transfer: true, delete: true, needsPassword: false },
      ...notice,
    },
  };
}

const STATES: ReadonlyArray<{ label: string; connection: CommunityConnectionDescriptor }> = [
  {
    label: 'Waiting, with a date — the owner can keep it, hand it on, or delete it',
    connection: ownerConnection('notice-waiting', 'active'),
  },
  {
    label: 'Notice still being sent — no date yet, so the shortest wait is named',
    connection: ownerConnection('notice-sending', 'active', {
      requestState: 'notifying',
      claimableAfter: null,
    }),
  },
  {
    label: 'Claimable, and the link for the new owner was sent again',
    connection: ownerConnection('notice-claimable', 'active', {
      requestState: 'claimable',
      claimReissuedAt: '2026-10-05T08:00:00.000Z',
    }),
  },
  {
    label: 'On hold — handing it on is not possible, only deleting',
    connection: ownerConnection('notice-held', 'archived', {
      options: { keep: true, transfer: false, delete: true, needsPassword: false },
    }),
  },
  {
    label: 'Owner signs in only through single sign-on — no password yet',
    connection: ownerConnection('notice-sso', 'active', {
      options: { keep: true, transfer: false, delete: false, needsPassword: true },
    }),
  },
];

/** The owner-replacement banner, in each of its states. */
export function CommunityOwnerNoticeShowcases() {
  return (
    <PlaygroundSection
      title="CommunityOwnerNoticeBanner"
      description="What the owner of a space sees at the top of its page when someone asked the host to make someone else the owner. It names when that could happen and offers only what this owner can do, and its one button opens the space in the browser, where keeping ownership is one press. Only the owner’s own connection ever carries it. Check that (a) each option line matches the state, and (b) the button drops under the text at phone width."
    >
      <div className="space-y-6">
        {STATES.map((state) => (
          <div key={state.connection.ref} className="space-y-2">
            <ShowcaseLabel>{state.label}</ShowcaseLabel>
            <ShowcaseDemo responsive>
              <CommunityOwnerNoticeBanner connection={state.connection} dateFormat={DATES} />
            </ShowcaseDemo>
          </div>
        ))}
      </div>
    </PlaygroundSection>
  );
}
