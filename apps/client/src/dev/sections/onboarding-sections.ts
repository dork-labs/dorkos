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
    id: 'meetdorkbotstep',
    title: 'MeetDorkBotStep',
    page: 'onboarding',
    category: 'Steps',
    keywords: ['meet', 'dorkbot', 'personality', 'traits', 'slider', 'avatar', 'preview'],
  },
  {
    id: 'agentdiscoverystep',
    title: 'AgentDiscoveryStep',
    page: 'onboarding',
    category: 'Steps',
    keywords: ['agent', 'discovery', 'scan', 'search', 'candidates', 'approve'],
  },
  {
    id: 'tasktemplatesstep',
    title: 'TaskTemplatesStep',
    page: 'onboarding',
    category: 'Steps',
    keywords: ['task', 'templates', 'schedule', 'cron', 'presets', 'pulse'],
  },
  {
    id: 'adaptersetupstep',
    title: 'AdapterSetupStep',
    page: 'onboarding',
    category: 'Steps',
    keywords: ['adapter', 'setup', 'relay', 'telegram', 'slack', 'webhook'],
  },
  {
    id: 'onboardingcomplete',
    title: 'OnboardingComplete',
    page: 'onboarding',
    category: 'Steps',
    keywords: ['complete', 'done', 'confetti', 'summary', 'finish'],
  },
  {
    id: 'onboardingnavbar',
    title: 'OnboardingNavBar',
    page: 'onboarding',
    category: 'Supporting',
    keywords: ['nav', 'bar', 'steps', 'back', 'skip', 'indicator', 'dots'],
  },
  {
    id: 'progresscard',
    title: 'ProgressCard',
    page: 'onboarding',
    category: 'Supporting',
    keywords: ['progress', 'card', 'sidebar', 'checklist', 'getting started'],
  },
];
