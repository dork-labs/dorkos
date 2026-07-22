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
