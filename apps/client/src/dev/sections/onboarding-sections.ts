import type { PlaygroundSection } from '../playground-registry';

/**
 * Onboarding page sections — the first run, each of its screens, the #team
 * chips it lands on, the trust notice the next launch shows, and the supporting
 * sidebar card.
 */
export const ONBOARDING_SECTIONS: PlaygroundSection[] = [
  {
    id: 'onboardingflow',
    title: 'OnboardingFlow',
    page: 'onboarding',
    category: 'Flow',
    keywords: ['onboarding', 'flow', 'interactive', 'first run', 'ftue', 'one minute'],
  },
  {
    id: 'welcomestep',
    title: 'WelcomeStep',
    page: 'onboarding',
    category: 'Screens',
    keywords: ['welcome', 'continue with dorkos', 'own ai', 'without an account', 'eligibility'],
  },
  {
    id: 'connectingstep',
    title: 'ConnectingStep',
    page: 'onboarding',
    category: 'Screens',
    keywords: ['connecting', 'link', 'code', 'browser', 'card', 'refused', 'us only', 'expired'],
  },
  {
    id: 'ownaistep',
    title: 'OwnAiStep',
    page: 'onboarding',
    category: 'Screens',
    keywords: ['own ai', 'api key', 'openai', 'anthropic', 'openrouter', 'ollama', 'ai app'],
  },
  {
    id: 'firstrunchips',
    title: 'FirstRunChips',
    page: 'onboarding',
    category: 'Landing',
    keywords: ['chips', 'team', 'welcome', 'dorkbot', 'tracker', 'plan board', 'connect'],
  },
  {
    id: 'runtimesetuppanel',
    title: 'RuntimeSetupPanel',
    page: 'onboarding',
    category: 'Runtimes',
    keywords: ['runtime', 'setup', 'needs setup', 'add a runtime', 'opencode', 'codex', 'install'],
  },
  {
    id: 'progresscard',
    title: 'ProgressCard',
    page: 'onboarding',
    category: 'Supporting',
    keywords: ['progress', 'card', 'sidebar', 'checklist', 'getting started', 'community', 'space'],
  },
  {
    id: 'trustnoticemoment',
    title: 'TrustNoticeMoment',
    page: 'onboarding',
    category: 'Landing',
    keywords: ['trust', 'notice', 'trusted', 'careful', 'permissions', 'moment', 'without asking'],
  },
];
