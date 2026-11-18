import type { PlaygroundSection } from '../playground-registry';

/**
 * The Agent browser's sections on the Home, Inbox & Approvals page: the
 * handoff card, the chrome row, the status pill, the panel and its page
 * errors. `FEATURE_SURFACE_SECTIONS` spreads them in at their old place, so
 * the page order is unchanged; they live here to keep that file under the
 * 500-line limit.
 *
 * Sources: BrowserHandoffShowcases, BrowserChromeShowcases,
 * BrowserStatusPillShowcases, LocalBrowserPanelShowcases,
 * BrowserPageErrorShowcases.
 *
 * @module dev/sections/features-browser-sections
 */
export const FEATURE_BROWSER_SECTIONS: PlaygroundSection[] = [
  // BrowserHandoffShowcases
  {
    id: 'browser-handoff-card',
    title: 'Browser handoff card',
    page: 'home-inbox',
    category: 'Home',
    keywords: ['browser', 'agent browser', 'handoff', 'sign in', 'password', 'paused', 'continue'],
  },
  // BrowserChromeShowcases
  {
    id: 'browser-chrome',
    title: 'Browser chrome',
    page: 'home-inbox',
    category: 'Home',
    keywords: [
      'browser',
      'address bar',
      'back',
      'forward',
      'reload',
      'not secure',
      'chrome',
      'menu',
      'pages',
      'copy address',
      'close browser',
    ],
  },
  // BrowserStatusPillShowcases
  {
    id: 'browser-status-pill',
    title: 'Browser status pill',
    page: 'home-inbox',
    category: 'Home',
    keywords: ['browser', 'agent browser', 'pill', 'take over', 'your turn', 'hand back', 'paused'],
  },
  // LocalBrowserPanelShowcases
  {
    id: 'agent-browser-panel',
    title: 'Agent browser panel',
    page: 'home-inbox',
    category: 'Home',
    keywords: ['browser', 'agent browser', 'panel', 'not open yet', 'disconnected'],
  },
  // BrowserPageErrorShowcases
  {
    id: 'agent-browser-page-errors-and-loading',
    title: 'Agent browser page errors and loading',
    page: 'home-inbox',
    category: 'Home',
    keywords: [
      'browser',
      'agent browser',
      'error',
      'offline',
      'certificate',
      'loading',
      'seam',
      'refused',
      'sign in',
    ],
  },
];
