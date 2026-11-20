import type { LocalBrowserSignIn } from '@dorkos/shared/local-browser';
import type { LocalBrowserRefusal } from '@dorkos/shared/local-browser-refusal';
import { siteName } from '@dorkos/shared/site-name';

/** What the notice's button does: open the plain sign-in window, or go on in its own window. */
export type RefusalNoticeAction = 'sign-in' | 'own-window';

/** One notice, ready to draw. `key` names the page it is about, for Dismiss. */
export interface RefusalNotice {
  key: string;
  text: string;
  action: { label: string; kind: RefusalNoticeAction };
}

/**
 * The in-app page notice for a site that refuses this browser (DOR-4097), or null.
 * A real load failure wins: its block covers the page. Dismiss holds for the same
 * page and lets the next refused page show again. A saved sign-in for this site
 * offers its own window, where the sign-in is, and waits for the person's click.
 *
 * @param input - The shell's refusal and failure for the page, the page's address,
 *   the latest sign-in, and the key the person last dismissed.
 */
export function refusalNotice(input: {
  refusal: LocalBrowserRefusal | null | undefined;
  url: string;
  failure?: { code: string; host: string; url: string } | null;
  signIn?: LocalBrowserSignIn | null;
  dismissed?: string | null;
}): RefusalNotice | null {
  const { refusal, url, failure, signIn, dismissed } = input;
  if (failure || !refusal) return null;
  const site = siteName(refusal.host);
  const notice: RefusalNotice =
    signIn?.status === 'saved' && siteName(signIn.site) === site
      ? {
          key: `saved:${signIn.startedAt}`,
          text: `Signed in to ${site}. It works in its own window, not here.`,
          action: { label: 'Open in its own window', kind: 'own-window' },
        }
      : refusal.kind === 'sign-in'
        ? {
            key: `sign-in:${url}`,
            text: `${site} won’t let you sign in here.`,
            action: { label: 'Open sign-in window', kind: 'sign-in' },
          }
        : {
            // The plain window lets the person pass the check; the shared profile keeps it.
            key: `blocked:${url}`,
            text: `${site} won’t open here.`,
            action: { label: 'Open in its own window', kind: 'sign-in' },
          };
  return notice.key === dismissed ? null : notice;
}
