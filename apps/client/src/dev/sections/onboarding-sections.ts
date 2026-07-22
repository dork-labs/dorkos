import type { PlaygroundSection } from '../playground-registry';

/**
 * Onboarding page sections — full flow, individual steps, and supporting components.
 */
export const ONBOARDING_SECTIONS: PlaygroundSection[] = [
  {
    id: 'onboardingflow',
    title: 'OnboardingFlow',
    page: 'onboarding',
    category: 'Flow',
    keywords: ['onboarding', 'flow', 'interactive', 'full', 'walkthrough', 'ftue'],
  },
  {
    id: 'systemrequirementsstep',
    title: 'SystemRequirementsStep',
    page: 'onboarding',
    category: 'Steps',
    keywords: ['system', 'requirements', 'check', 'dependencies', 'install', 'claude', 'cli'],
  },
  {
    id: 'runtimesetuppanel',
    title: 'RuntimeSetupPanel',
    page: 'onboarding',
    category: 'Runtimes',
    keywords: ['runtime', 'setup', 'needs setup', 'add a runtime', 'opencode', 'codex', 'install'],
  },
  {
    id: 'modelnaturebadge',
    title: 'ModelNatureBadge',
    page: 'onboarding',
    category: 'Runtimes',
    keywords: [
      'model',
      'nature',
      'badge',
      'local',
      'cloud',
      'ollama',
      'private',
      'free',
      'per-token',
      'capability',
    ],
  },
  {
    id: 'welcomestep',
    title: 'WelcomeStep',
    page: 'onboarding',
    category: 'Steps',
    keywords: ['welcome', 'step', 'onboarding', 'get started', 'skip', 'animation'],
  },
  {
    id: 'onboardingnavbar',
    title: 'OnboardingNavBar',
    page: 'onboarding',
    category: 'Supporting',
    keywords: ['nav', 'bar', 'back', 'skip', 'setup'],
  },
  {
    id: 'progresscard',
    title: 'ProgressCard',
    page: 'onboarding',
    category: 'Supporting',
    keywords: ['progress', 'card', 'sidebar', 'checklist', 'getting started'],
  },
];
