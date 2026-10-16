/**
 * Read a secret from the link fragment into page memory only, then erase it from the address bar
 * and the current history entry. `main.tsx` imports this module first, so it runs before any
 * other module of the page does. It used to be an inline script in `index.html`; the page's
 * content security policy allows no inline script (DOR-2957), so it lives in the bundle instead.
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
  const path = window.location.pathname;
  const claimPage = path === '/claim';
  const replacementPage = path === '/keep-ownership' || path === '/owner-replacement';
  const emailLinkPage =
    path === '/reset-password' || path === '/email-sign-in' || path === '/confirm-email';
  const barePage = replacementPage || emailLinkPage;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  let secret: string | null = barePage
    ? window.location.hash.slice(1) || null
    : claimPage
      ? fragment.get('claim')
      : (fragment.get('invite') ?? fragment.get('token'));
  if ((claimPage || barePage) && window.location.hash)
    window.history.replaceState(null, '', path + window.location.search);
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
  const tenant = window.location.pathname.match(/^\/c\/[^/]+/u)?.[0];
  const cleanPath = tenant ? `${tenant}/join` : window.location.pathname;
  window.history.replaceState(null, '', cleanPath + window.location.search);
}

captureLinkSecret();
