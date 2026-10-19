import type {
  CommunityWireAgent,
  CommunityWireAttachment,
  CommunityWireChannel,
  CommunityWireEntry,
  CommunityWireMember,
  CommunityWireMembershipSummary,
} from '@dorkos/shared/community-wire';

export type Community = { id: string; name: string; description: string | null; createdAt: string };
export type CommunityLifecycle = CommunityWireMembershipSummary['lifecycle'];
export type Channel = CommunityWireChannel;
export type Entry = CommunityWireEntry;
export type Member = CommunityWireMember;
export type Agent = CommunityWireAgent;
export type Attachment = CommunityWireAttachment;
export type Me = { member: Member };
export type Status = 'loading' | 'ready' | 'error';
