/**
 * Turn a link's fragment into the secret its page reads, in page memory only. The fragment never
 * reaches this module through the address bar: the page's one inline script
 * (`src/headers/link-secret-script.ts`) took it out while the page was still parsing, before the
 * bundle loaded, and left it in `window.__dorkosLinkFragment` for this module to read once.
 * `main.tsx` imports this module first, so it runs before any other module of the page does.
 *
 * The secret never reaches this server: it travels after `#`, and the page sends no referrer.
 */

/** Which pair of window functions a page's secret is read and cleared through. */
const READERS = {
  emailLink: ['__readDorkosEmailLinkFragment', '__clearDorkosEmailLinkFragment'],
  ownerReplacement: [
    '__readDorkosOwnerReplacementFragment',
    '__clearDorkosOwnerReplacementFragment',
  ],
  ownerClaim: ['__readDorkosOwnerClaimFragment', '__clearDorkosOwnerClaimFragment'],
  invite: ['__readDorkosInviteFragment', '__clearDorkosInviteFragment'],
} as const;

/**
 * Capture the current page's link secret, if it has one, and clean the address.
 *
 * The owner's keep-ownership link, the new owner's claim link and the mailed reset, sign-in and
 * confirmation links carry the bare token; the owner-claim page carries `claim=`; every other
 * page may carry an invitation as `invite=` or `token=`.
 */
export function captureLinkSecret(): void {
  const raw = takeCapturedFragment();
  const path = window.location.pathname;
  const claimPage = path === '/claim';
  const replacementPage = path === '/keep-ownership' || path === '/owner-replacement';
  const emailLinkPage =
    path === '/reset-password' || path === '/email-sign-in' || path === '/confirm-email';
  const barePage = replacementPage || emailLinkPage;
  const fragment = new URLSearchParams(raw);
  let secret: string | null = barePage
    ? raw || null
    : claimPage
      ? fragment.get('claim')
      : (fragment.get('invite') ?? fragment.get('token'));
  if (!secret) return;
  const [read, clear] = emailLinkPage
    ? READERS.emailLink
    : replacementPage
      ? READERS.ownerReplacement
      : claimPage
        ? READERS.ownerClaim
        : READERS.invite;
  const target = window as unknown as Record<string, unknown>;
  Object.defineProperties(window, {
    [read]: { value: () => secret, configurable: true, enumerable: false, writable: false },
    [clear]: {
      value: () => {
        secret = null;
        delete target[read];
        delete target[clear];
      },
      configurable: true,
      enumerable: false,
      writable: false,
    },
  });
  if (claimPage || barePage) return;
  // An invitation opens its space's join page.
  const tenant = window.location.pathname.match(/^\/c\/[^/]+/u)?.[0];
  const cleanPath = tenant ? `${tenant}/join` : window.location.pathname;
  window.history.replaceState(null, '', cleanPath + window.location.search);
}

/** Read, once, the fragment the page's inline script took out of the address bar. */
function takeCapturedFragment(): string {
  const target = window as unknown as Record<string, unknown>;
  const raw = target.__dorkosLinkFragment;
  delete target.__dorkosLinkFragment;
  return typeof raw === 'string' ? raw : '';
}

captureLinkSecret();
