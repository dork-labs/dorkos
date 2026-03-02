/**
 * Onboarding feature — hooks for first-time user experience state management.
 *
 * @module features/onboarding
 */
export { useOnboarding } from './model/use-onboarding';
export { useDiscoveryScan } from './model/use-discovery-scan';
export type { ScanCandidate, ScanProgress, ScanOptions } from './model/use-discovery-scan';
export { usePulsePresets } from './model/use-pulse-presets';
export type { PulsePreset } from './model/use-pulse-presets';
export { OnboardingFlow } from './ui/OnboardingFlow';
export { WelcomeStep } from './ui/WelcomeStep';
export { AgentCard } from './ui/AgentCard';
export { AgentDiscoveryStep } from './ui/AgentDiscoveryStep';
export { NoAgentsFound } from './ui/NoAgentsFound';
export { PresetCard } from './ui/PresetCard';
export { PulsePresetsStep } from './ui/PulsePresetsStep';
export { AdapterSetupStep } from './ui/AdapterSetupStep';
export { OnboardingComplete } from './ui/OnboardingComplete';
export { DiscoveryCelebration } from './ui/DiscoveryCelebration';
export { ProgressCard } from './ui/ProgressCard';
