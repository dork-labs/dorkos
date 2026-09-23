/**
 * Hosted communities in the DorkOS app: "Start a community", "Move a community
 * here" and the account's hosted-community list, offered from the community
 * switcher only while this DorkOS is linked to a DorkOS account
 * (community-host-operator-api P5).
 *
 * FSD: `features/community-hosting`. Reads the cloud-link summary through the
 * `features/cloud-link` barrel and pairs through `entities/community`. The
 * step builders and the preview frame are exported for the Dev Playground,
 * which shows every state at once.
 *
 * @module features/community-hosting
 */
export {
  useCommunityHostingEntry,
  type CommunityHostingEntry,
} from './model/use-community-hosting-entry';
export {
  CommunityHostingDialogs,
  type CommunityHostingDialog,
  type CommunityHostingDialogsProps,
} from './ui/CommunityHostingDialogs';
export { HostingStepPreview, type HostingStep } from './ui/hosting-step';
export { claimConnectStep } from './ui/claim-connect-step';
export { startFormStep } from './ui/StartCommunityDialog';
export {
  moveChooseStep,
  moveExplainStep,
  moveProgressStep,
  moveSendingStep,
  MOVE_DONE_DETAIL,
} from './ui/MoveCommunityDialog';
export { HostedCommunityList } from './ui/HostedCommunitiesDialog';
export { moveStepOf } from './model/use-move-community';
