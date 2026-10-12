/**
 * Onboarding feature — the first run (spec `one-minute-onboarding`) and the
 * first-time prompts that follow it.
 *
 * @module features/onboarding
 */
export { useOnboarding } from './model/use-onboarding';
export { useOnboardingOverlayVisible } from './model/use-onboarding-overlay';
export { useOnboardingStage, useClearOnboardingStageWhenDone } from './model/use-onboarding-stage';
export {
  ONBOARDING_STAGES,
  onboardingStageSearchSchema,
  isOnboardingStage,
  type OnboardingStage,
} from './model/onboarding-stage';
export type {
  FirstRunAccountLink,
  FirstRunAccountLinkSlot,
  FirstRunPendingCode,
  FirstRunSlots,
  OtherServiceSaveProps,
  OtherServiceSlot,
} from './model/first-run-slots';
export type { DorkosConnectPhase } from './model/use-dorkos-connect';
export { OnboardingFlow } from './ui/OnboardingFlow';
export { WelcomeStep } from './ui/WelcomeStep';
export { ConnectingStep } from './ui/ConnectingStep';
export { OwnAiStep } from './ui/OwnAiStep';
export { ProgressCard } from './ui/ProgressCard';
export { ProfilePromptCard } from './ui/ProfilePromptCard';
export type { ProfilePromptCardProps } from './ui/ProfilePromptCard';
// The role prompt's show condition and its ask → saved → gone arc, lifted out of
// the card so the sidebar's bottom slot can arbitrate it (spec
// `sidebar-simplification` D4).
export { useProfilePrompt } from './model/use-profile-prompt';
export type { ProfilePromptApi, ProfilePromptPhase } from './model/use-profile-prompt';
// The one-time name-and-handle card (DOR-677), arbitrated by the same slot.
export { useIdentityPrompt } from './model/use-identity-prompt';
export type {
  IdentityPromptApi,
  IdentityPromptPhase,
  IdentityQuestion,
} from './model/use-identity-prompt';
export { IdentityPromptCard } from './ui/IdentityPromptCard';
// The first run's offer to join the official DorkOS space (DOR-2873): inside the
// Getting started card, or the bottom slot's own card while that one waits.
export { useFirstRunSpaceOffer } from './model/use-first-run-space-offer';
export type { FirstRunSpaceOffer } from './model/use-first-run-space-offer';
export type { IdentityPromptCardProps } from './ui/IdentityPromptCard';
