import type { PlaygroundSection } from '../playground-registry';
import { APP_TABS_SECTIONS } from './app-tabs-sections';

/** Settings and app tabs shown on the components playground page. */
export const COMPONENTS_SETTINGS_SECTIONS: PlaygroundSection[] = [
  ...APP_TABS_SECTIONS,
  {
    id: 'sign-in-identity',
    title: 'Sign-in identity',
    page: 'components',
    category: 'Settings',
    keywords: ['Claude', 'sign-in', 'identity', 'exclusions'],
  },
];
