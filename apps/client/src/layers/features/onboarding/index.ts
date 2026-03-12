/**
 * Onboarding feature — hooks for first-time user experience state management.
 *
 * @module features/onboarding
 */
export { useOnboarding } from './model/use-onboarding';
export { usePulsePresets } from '@/layers/entities/pulse';
export type { PulsePreset } from '@/layers/entities/pulse';
export { PresetCard } from '@/layers/features/pulse';
export { OnboardingFlow } from './ui/OnboardingFlow';
export { WelcomeStep } from './ui/WelcomeStep';
export { AgentCard } from './ui/AgentCard';
export { AgentDiscoveryStep } from './ui/AgentDiscoveryStep';
export { NoAgentsFound } from './ui/NoAgentsFound';
export { PulsePresetsStep } from './ui/PulsePresetsStep';
export { AdapterSetupStep } from './ui/AdapterSetupStep';
export { OnboardingComplete } from './ui/OnboardingComplete';
export { DiscoveryCelebration } from './ui/DiscoveryCelebration';
export { ProgressCard } from './ui/ProgressCard';
