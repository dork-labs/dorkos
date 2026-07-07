import type { PlaygroundSection } from '../playground-registry';

/**
 * Feature component sections from FeaturesPage.
 *
 * Sources: AgentIdentityShowcases, AgentSidebarShowcases, RelayShowcases, MeshShowcases, TasksShowcases.
 */
export const FEATURES_SECTIONS: PlaygroundSection[] = [
  // PersonalityPickerShowcases
  {
    id: 'personalitypicker',
    title: 'PersonalityPicker',
    page: 'features',
    category: 'Agent',
    keywords: [
      'personality',
      'picker',
      'radar',
      'preset',
      'traits',
      'nebula',
      'archetype',
      'slider',
    ],
  },
  // AgentIdentityShowcases
  {
    id: 'agentavatar',
    title: 'AgentAvatar',
    page: 'features',
    category: 'Agent',
    keywords: ['agent', 'avatar', 'emoji', 'color', 'identity', 'health', 'status'],
  },
  {
    id: 'agentidentity',
    title: 'AgentIdentity',
    page: 'features',
    category: 'Agent',
    keywords: ['agent', 'identity', 'card', 'name', 'avatar', 'detail', 'profile'],
  },
  // RelayShowcases
  {
    id: 'catalogcard',
    title: 'CatalogCard',
    page: 'features',
    category: 'Relay',
    keywords: ['catalog', 'card', 'adapter', 'manifest', 'add', 'relay'],
  },
  {
    id: 'connectionstatusbanner',
    title: 'ConnectionStatusBanner',
    page: 'features',
    category: 'Relay',
    keywords: ['connection', 'status', 'banner', 'disconnected', 'reconnecting', 'relay'],
  },
  {
    id: 'relayemptystate',
    title: 'RelayEmptyState',
    page: 'features',
    category: 'Relay',
    keywords: ['relay', 'empty', 'state', 'adapter', 'onboarding'],
  },
  // AdapterWizardShowcases
  {
    id: 'stepindicator',
    title: 'StepIndicator',
    page: 'features',
    category: 'Relay',
    keywords: ['step', 'indicator', 'wizard', 'progress', 'stepper', 'relay'],
  },
  {
    id: 'configurestep',
    title: 'ConfigureStep',
    page: 'features',
    category: 'Relay',
    keywords: ['configure', 'step', 'wizard', 'form', 'adapter', 'relay'],
  },
  {
    id: 'configfieldinput',
    title: 'ConfigFieldInput',
    page: 'features',
    category: 'Relay',
    keywords: ['config', 'field', 'input', 'form', 'password', 'select', 'boolean', 'relay'],
  },
  {
    id: 'configfieldinput-error-states',
    title: 'ConfigFieldInput — Error States',
    page: 'features',
    category: 'Relay',
    keywords: ['config', 'field', 'input', 'error', 'validation', 'form', 'relay'],
  },
  {
    id: 'teststep',
    title: 'TestStep',
    page: 'features',
    category: 'Relay',
    keywords: ['test', 'step', 'wizard', 'connection', 'pending', 'success', 'error', 'relay'],
  },
  {
    id: 'confirmstep',
    title: 'ConfirmStep',
    page: 'features',
    category: 'Relay',
    keywords: ['confirm', 'step', 'wizard', 'summary', 'review', 'mask', 'relay'],
  },
  {
    id: 'bindstep',
    title: 'BindStep',
    page: 'features',
    category: 'Relay',
    keywords: ['bind', 'step', 'wizard', 'agent', 'routing', 'session', 'strategy', 'relay'],
  },
  {
    id: 'setupguidesheet',
    title: 'SetupGuideSheet',
    page: 'features',
    category: 'Relay',
    keywords: ['setup', 'guide', 'sheet', 'markdown', 'instructions', 'relay'],
  },
  {
    id: 'adapterbindingrow',
    title: 'AdapterBindingRow',
    page: 'features',
    category: 'Relay',
    keywords: ['adapter', 'binding', 'row', 'agent', 'permission', 'strategy', 'relay'],
  },
  // AgentSidebarShowcases
  {
    id: 'agentactivitybadge',
    title: 'AgentActivityBadge',
    page: 'features',
    category: 'Agent',
    keywords: ['agent', 'activity', 'badge', 'dot', 'status', 'streaming', 'error', 'sidebar'],
  },
  {
    id: 'sessionrow-compact',
    title: 'SessionRow (compact)',
    page: 'features',
    category: 'Agent',
    keywords: ['session', 'row', 'compact', 'dot', 'sidebar', 'preview', 'variant'],
  },
  {
    id: 'agentlistitem',
    title: 'AgentListItem',
    page: 'features',
    category: 'Agent',
    keywords: ['agent', 'list', 'item', 'sidebar', 'expandable', 'row', 'pin', 'select'],
  },
  {
    id: 'agentcontextmenu',
    title: 'AgentContextMenu',
    page: 'features',
    category: 'Agent',
    keywords: ['agent', 'context', 'menu', 'right-click', 'pin', 'profile', 'sidebar'],
  },
  {
    id: 'agentonboardingcard',
    title: 'AgentOnboardingCard',
    page: 'features',
    category: 'Agent',
    keywords: ['agent', 'onboarding', 'card', 'empty', 'state', 'sidebar', 'add'],
  },
  // MeshShowcases
  {
    id: 'meshemptystate',
    title: 'MeshEmptyState',
    page: 'features',
    category: 'Mesh',
    keywords: ['mesh', 'empty', 'state', 'topology', 'preview', 'agent'],
  },
  // TasksShowcases
  {
    id: 'tasktemplatecard',
    title: 'TaskTemplateCard',
    page: 'features',
    category: 'Tasks',
    keywords: ['preset', 'card', 'schedule', 'toggle', 'selectable', 'cron', 'tasks'],
  },
];
