import type { PlaygroundSection } from '../playground-registry';

/**
 * The components page's feedback sections. Spread into the components page's
 * list where these showcases render, so the TOC order matches the page.
 *
 * Sources: AccountSigninShowcases, FeedbackShowcases.
 */
export const FEEDBACK_SECTIONS: PlaygroundSection[] = [
  // AccountSigninShowcases
  {
    id: 'account-sign-in-recovery',
    title: 'Account sign-in recovery',
    page: 'components',
    category: 'Feedback',
    keywords: ['account', 'sign-in', 'signin', 'login', 'claude', 'banner', 'runtimes', 'recovery'],
  },
  // FeedbackShowcases
  {
    id: 'feedback-dialog',
    title: 'Feedback dialog',
    page: 'components',
    category: 'Feedback',
    keywords: [
      'feedback',
      'bug',
      'report',
      'idea',
      'praise',
      'diagnostics',
      'attachments',
      'screenshot',
      'paste',
      'drop',
      'capture',
      'point',
      'composer',
      'email',
      'signed out',
      'draft',
    ],
  },
  {
    id: 'point-at-it-still',
    title: 'Point at it (still)',
    page: 'components',
    category: 'Feedback',
    keywords: [
      'point',
      'element',
      'picker',
      'crosshair',
      'highlight',
      'crop',
      'bug',
      'report',
      'screenshot',
      'overlay',
    ],
  },
  {
    id: 'skeleton',
    title: 'Skeleton',
    page: 'components',
    category: 'Feedback',
    keywords: ['loading', 'placeholder', 'tasks', 'shimmer', 'spinner'],
  },

  {
    id: 'copy-feedback',
    title: 'Copy feedback',
    page: 'components',
    category: 'Feedback',
    keywords: ['copy', 'clipboard', 'useCopyFeedback', 'CopyButton', 'copied', 'failed'],
  },
  {
    id: 'toaster',
    title: 'Toaster',
    page: 'components',
    category: 'Feedback',
    keywords: ['toast', 'notification', 'sonner', 'success', 'error', 'info', 'warning'],
  },
  {
    id: 'banner',
    title: 'Banner',
    page: 'components',
    category: 'Feedback',
    keywords: ['banner', 'alert', 'notice', 'critical', 'warning', 'info', 'neutral', 'dismiss'],
  },
  {
    id: 'permissionmodescopenote',
    title: 'PermissionModeScopeNote',
    page: 'components',
    category: 'Feedback',
    keywords: [
      'permission',
      'mode',
      'scope',
      'note',
      'bypass',
      'never asks',
      'covers',
      'approvals',
    ],
  },
  {
    id: 'unverifiedcatalognotice',
    title: 'UnverifiedCatalogNotice',
    page: 'components',
    category: 'Feedback',
    keywords: ['unverified', 'catalog', 'notice', 'model', 'bounded', 'guess', 'connect'],
  },
];
