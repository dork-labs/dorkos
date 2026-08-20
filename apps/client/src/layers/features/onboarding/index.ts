/**
 * Onboarding feature — hooks for first-time user experience state management.
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
export { OnboardingFlow } from './ui/OnboardingFlow';
export { SystemRequirementsStep } from './ui/SystemRequirementsStep';
export { WelcomeStep } from './ui/WelcomeStep';
export { OnboardingConversation } from './ui/OnboardingConversation';
export { OnboardingNavBar } from './ui/OnboardingNavBar';
export { ProgressCard } from './ui/ProgressCard';
export { ProfilePromptCard } from './ui/ProfilePromptCard';
export type { ProfilePromptCardProps } from './ui/ProfilePromptCard';
// The role prompt's show condition and its ask → saved → gone arc, lifted out of
// the card so the sidebar's bottom slot can arbitrate it (spec
// `sidebar-simplification` D4).
export { useProfilePrompt } from './model/use-profile-prompt';
export type { ProfilePromptApi, ProfilePromptPhase } from './model/use-profile-prompt';
