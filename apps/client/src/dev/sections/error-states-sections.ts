import type { PlaygroundSection } from '../playground-registry';

/** Error states sections for the dev playground error states page. */
export const ERROR_STATES_SECTIONS: PlaygroundSection[] = [
  {
    id: 'route-error-fallback',
    title: 'Route Error Fallback',
    page: 'error-states',
    category: 'Error States',
    keywords: ['error', 'boundary', 'crash', 'route', 'fallback', 'retry'],
  },
  {
    id: 'not-found-fallback',
    title: 'Not Found Fallback',
    page: 'error-states',
    category: 'Error States',
    keywords: ['404', 'not found', 'missing', 'page'],
  },
  {
    id: 'app-crash-fallback',
    title: 'App Crash Fallback',
    page: 'error-states',
    category: 'Error States',
    keywords: ['crash', 'fatal', 'reload', 'catastrophic', 'inline styles'],
  },
  {
    id: 'agent-paused-notice',
    title: 'Agent Paused Notice',
    page: 'error-states',
    category: 'Error States',
    keywords: ['pause', 'paused', 'resume', 'agent', 'composer', 'audit'],
  },
  {
    id: 'error-toasts',
    title: 'Error Toasts',
    page: 'error-states',
    category: 'Error States',
    keywords: ['toast', 'notification', 'mutation', 'query', 'sonner'],
  },
];
